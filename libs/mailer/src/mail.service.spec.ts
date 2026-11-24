import { EventEmitter } from 'node:events';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MailerModule, MailerService } from '@nestjs-modules/mailer';
import { mailConfig } from '@platform/config';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_TEMPLATE_DIRS } from '../test/fixtures/template-dirs.js';
import { MailService } from './mail.service.js';
import type { MailJobData } from './mail.types.js';
import { toMailJobId } from './mail.util.js';
import { MAIL_JOB_OPTIONS, MAIL_SENT_MARKER_TTL_SEC } from './mailer.constants.js';
import { createMailerOptions } from './mailer-options.factory.js';

const cfg = mailConfig.parse({ MAIL_FROM: '"Acme" <no-reply@acme.test>' });

type FakeQueue = Queue<MailJobData, void, string> & {
  add: ReturnType<typeof vi.fn>;
  getBackend: ReturnType<typeof vi.fn>;
  /** The queue's Redis: key → value and the `EX` it was set with. */
  redis: Map<string, { value: string; ex: number | undefined }>;
  /** Ids of the jobs `add` created (an add whose job id still exists creates none). */
  created: string[];
  /** BullMQ removing the job (`removeOnComplete` after 24 h, or the 10,000 count). */
  removeJob(jobId: string): void;
};

/**
 * A queue that deduplicates on the job id while the job exists, as BullMQ does, over a fake of
 * the queue's own Redis connection (`getBackend().client`) for the sent marker.
 */
function createQueue(): FakeQueue {
  const jobs = new Set<string>();
  const created: string[] = [];
  const redis: FakeQueue['redis'] = new Map();
  const add = vi.fn(async (_name: string, _data: MailJobData, opts?: { jobId?: string }) => {
    const id = opts?.jobId ?? 'auto-1';
    if (!jobs.has(id)) {
      jobs.add(id);
      created.push(id);
    }
    return { id };
  });
  const client = {
    get: vi.fn(async (key: string) => redis.get(key)?.value ?? null),
    set: vi.fn(async (key: string, value: string, options?: { EX?: number }) => {
      redis.set(key, { value, ex: options?.EX });
      return 'OK';
    }),
  };
  const getBackend = vi.fn(() => ({ client: Promise.resolve(client) }));
  return {
    add,
    on: vi.fn(),
    getBackend,
    toKey: (type: string) => `bull:mail:${type}`,
    redis,
    created,
    removeJob: (jobId: string) => jobs.delete(jobId),
  } as unknown as FakeQueue;
}

function createMailer(): MailerService & { sendMail: ReturnType<typeof vi.fn> } {
  const sendMail = vi.fn(async () => ({ messageId: '<m1@acme.test>' }));
  return { sendMail } as unknown as MailerService & { sendMail: ReturnType<typeof vi.fn> };
}

const reminder = {
  to: 'jane@example.com',
  subject: 'Reminder',
  template: 'reminder',
  context: { displayName: 'Jane' },
} as const;

describe('MailService.enqueue', () => {
  it('adds a job named after the template with the mail job options', async () => {
    const queue = createQueue();
    const service = new MailService(queue, createMailer(), cfg);

    const result = await service.enqueue({ ...reminder, idempotencyKey: 'reminder-0199a3c1' });

    expect(queue.add).toHaveBeenCalledWith(
      'reminder',
      {
        to: 'jane@example.com',
        subject: 'Reminder',
        template: 'reminder',
        context: reminder.context,
      },
      { ...MAIL_JOB_OPTIONS, jobId: 'reminder-0199a3c1' },
    );
    expect(result).toEqual({ jobId: 'reminder-0199a3c1' });
  });

  it('never stores the idempotency key in the job payload', async () => {
    const queue = createQueue();

    await new MailService(queue, createMailer(), cfg).enqueue({
      ...reminder,
      idempotencyKey: 'k1',
    });

    expect(queue.add.mock.calls[0]?.[1]).not.toHaveProperty('idempotencyKey');
  });

  it('hashes keys BullMQ would reject (":" or integer strings) deterministically', async () => {
    const queue = createQueue();
    // A second queue: on the first one the sent marker would skip the repeated key.
    const other = createQueue();
    const service = new MailService(queue, createMailer(), cfg);

    await service.enqueue({ ...reminder, idempotencyKey: 'reminder:u1' });
    await new MailService(other, createMailer(), cfg).enqueue({
      ...reminder,
      idempotencyKey: 'reminder:u1',
    });
    await service.enqueue({ ...reminder, idempotencyKey: '12345' });

    const jobIdOf = (q: FakeQueue, call: number): string | undefined =>
      (q.add.mock.calls[call]?.[2] as { jobId: string } | undefined)?.jobId;
    const [first, second, third] = [jobIdOf(queue, 0), jobIdOf(other, 0), jobIdOf(queue, 1)];
    expect(first).toMatch(/^k-[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(third).toMatch(/^k-[0-9a-f]{64}$/);
  });

  it('lets BullMQ generate the id without a key', async () => {
    const queue = createQueue();

    const result = await new MailService(queue, createMailer(), cfg).enqueue(reminder);

    expect(queue.add.mock.calls[0]?.[2]).not.toHaveProperty('jobId');
    expect(result.jobId).toBe('auto-1');
  });

  it('adds nothing for a key it already enqueued, after the job was removed (the 24 h case)', async () => {
    const queue = createQueue();
    const service = new MailService(queue, createMailer(), cfg);

    const first = await service.enqueue({ ...reminder, idempotencyKey: 'reminder-0199a3c1' });
    queue.removeJob('reminder-0199a3c1');
    const replay = await service.enqueue({ ...reminder, idempotencyKey: 'reminder-0199a3c1' });

    expect(queue.created).toEqual(['reminder-0199a3c1']);
    expect(queue.add).toHaveBeenCalledOnce();
    expect(first).toEqual({ jobId: 'reminder-0199a3c1' });
    expect(replay).toEqual({ jobId: 'reminder-0199a3c1' });
  });

  it('marks a keyed mail as enqueued in the queue key space for the .dlq retention (14 days)', async () => {
    const queue = createQueue();
    const service = new MailService(queue, createMailer(), cfg);

    await service.enqueue({ ...reminder, idempotencyKey: 'reminder-0199a3c1' });
    await service.enqueue({ ...reminder, idempotencyKey: 'reminder:u1' });

    expect([...queue.redis.keys()]).toEqual([
      'bull:mail:mail-sent:reminder-0199a3c1',
      `bull:mail:mail-sent:${toMailJobId('reminder:u1')}`,
    ]);
    expect(MAIL_SENT_MARKER_TTL_SEC).toBe(14 * 24 * 3600);
    expect([...queue.redis.values()].map(({ ex }) => ex)).toEqual([
      MAIL_SENT_MARKER_TTL_SEC,
      MAIL_SENT_MARKER_TTL_SEC,
    ]);
  });

  it('keeps the marker when a short retention deletes the job at once (secret job data)', async () => {
    const queue = createQueue();
    const service = new MailService(queue, createMailer(), cfg);
    const retention = { removeOnComplete: true, removeOnFail: true } as const;

    await service.enqueue({ ...reminder, idempotencyKey: 'access-code-1' }, retention);
    queue.removeJob('access-code-1');
    await service.enqueue({ ...reminder, idempotencyKey: 'access-code-1' }, retention);

    expect(queue.created).toEqual(['access-code-1']);
    expect(queue.add).toHaveBeenCalledOnce();
  });

  it('without a key, adds every time and never reads or writes a marker', async () => {
    const queue = createQueue();
    const service = new MailService(queue, createMailer(), cfg);

    await service.enqueue(reminder);
    await service.enqueue(reminder);

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.getBackend).not.toHaveBeenCalled();
    expect(queue.redis.size).toBe(0);
  });

  it('sets no marker when the add fails, so a redelivery enqueues the mail', async () => {
    const queue = createQueue();
    const service = new MailService(queue, createMailer(), cfg);
    queue.add.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:6379'));

    await expect(
      service.enqueue({ ...reminder, idempotencyKey: 'reminder-0199a3c1' }),
    ).rejects.toThrow('ECONNREFUSED');
    expect(queue.redis.size).toBe(0);

    await service.enqueue({ ...reminder, idempotencyKey: 'reminder-0199a3c1' });
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.redis.has('bull:mail:mail-sent:reminder-0199a3c1')).toBe(true);
  });

  it('lets a caller shorten the retention of a job whose data is a secret (one-time codes)', async () => {
    const queue = createQueue();
    const service = new MailService(queue, createMailer(), cfg);

    await service.enqueue(
      { ...reminder, idempotencyKey: 'access-code-1' },
      { removeOnComplete: true, removeOnFail: true },
    );

    expect(queue.add.mock.calls[0]?.[2]).toEqual({
      ...MAIL_JOB_OPTIONS,
      removeOnComplete: true,
      removeOnFail: true,
      jobId: 'access-code-1',
    });
  });
});

describe('MailService.sendNow', () => {
  it('merges default context (appName from MAIL_FROM, year) under the caller context', async () => {
    const mailer = createMailer();

    await new MailService(createQueue(), mailer, cfg).sendNow({
      ...reminder,
      context: { displayName: 'Jane', appName: 'Override' },
    });

    expect(mailer.sendMail).toHaveBeenCalledWith({
      to: 'jane@example.com',
      subject: 'Reminder',
      template: 'reminder',
      context: { appName: 'Override', year: new Date().getUTCFullYear(), displayName: 'Jane' },
    });
  });

  it('passes the configured appUrl (MAIL_APP_URL) into the template context (F34)', async () => {
    const mailer = createMailer();
    const withUrl = mailConfig.parse({
      MAIL_FROM: '"Acme" <no-reply@acme.test>',
      MAIL_APP_URL: 'https://app.example.io',
    });

    await new MailService(createQueue(), mailer, withUrl).sendNow(reminder);

    expect(mailer.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ appUrl: 'https://app.example.io' }),
      }),
    );
  });

  it('renders templates from every registered dir with the shared partials (JSON transport)', async () => {
    @Module({
      imports: [
        MailerModule.forRootAsync({
          imports: [],
          useFactory: () => ({
            ...createMailerOptions(cfg, FIXTURE_TEMPLATE_DIRS),
            transport: { jsonTransport: true },
          }),
        }),
      ],
    })
    class TestMailModule {}
    const app = await NestFactory.createApplicationContext(TestMailModule, { logger: false });
    try {
      const mailer = app.get(MailerService);
      const send = vi.spyOn(mailer, 'sendMail');
      const service = new MailService(createQueue(), mailer, cfg);
      const sent = async (
        call: number,
      ): Promise<{ from: unknown; subject: string; html: string }> => {
        const info = (await send.mock.results[call]?.value) as { message: string };
        return JSON.parse(info.message) as { from: unknown; subject: string; html: string };
      };

      await service.sendNow({
        to: 'jane@example.com',
        subject: 'Hello',
        template: 'greeting',
        context: { name: 'Jane' },
      });
      await service.sendNow({
        to: 'jane@example.com',
        subject: 'Goodbye',
        template: 'farewell',
        context: { name: 'Jane' },
      });

      const greeting = await sent(0);
      const farewell = await sent(1);
      expect(greeting.from).toEqual({ address: 'no-reply@acme.test', name: 'Acme' });
      expect(greeting.html).toContain('Hello Jane!');
      expect(farewell.subject).toBe('Goodbye');
      expect(farewell.html).toContain('Goodbye Jane.');
      expect(farewell.html).toContain(`&copy; ${new Date().getUTCFullYear()} Acme`);
    } finally {
      await app.close();
    }
  });
});

describe('MailService queue errors', () => {
  it('listens to the queue "error" event from construction and logs through the Nest logger, throttled', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { add } = createQueue();
    const queue = Object.assign(new EventEmitter(), { add }) as unknown as EventEmitter &
      Queue<MailJobData, void, string>;

    // No lifecycle hook is called: the listener must exist as soon as the provider is created,
    // because a queue whose Redis is down at boot errors before any onModuleInit runs.
    new MailService(queue, createMailer(), cfg);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      queue.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    }

    expect(queue.listenerCount('error')).toBe(1);
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]?.[0])).toContain('Mail queue error: connect ECONNREFUSED');
  });
});
