import { Logger } from '@nestjs/common';
import { mailConfig } from '@platform/config';
import { type Job, UnrecoverableError } from 'bullmq';
import Handlebars from 'handlebars';
import { describe, expect, it, vi } from 'vitest';
import { MailProcessor } from './mail.processor.js';
import type { MailService } from './mail.service.js';
import type { MailJobData } from './mail.types.js';
import { MAIL_JOBS_TOTAL, type MailJobOutcome } from './mailer.constants.js';

const cfg = mailConfig.parse({ MAIL_QUEUE_CONCURRENCY: '12' });

function setup(sendNow: () => Promise<void> = async () => undefined) {
  const mail = { sendNow: vi.fn(sendNow) } as unknown as MailService & {
    sendNow: ReturnType<typeof vi.fn>;
  };
  const inc = vi.fn<(labels: { outcome: MailJobOutcome }, value?: number) => void>();
  /** Increments by one, `{ outcome }` of each, as `mail_jobs_total` would see them. */
  const counted = (): MailJobOutcome[] =>
    inc.mock.calls.filter(([, value]) => value !== 0).map(([labels]) => labels.outcome);
  return { mail, inc, counted, processor: new MailProcessor(mail, cfg, { inc }) };
}

function job(overrides: Partial<{ attemptsMade: number; attempts: number }> = {}) {
  return {
    id: 'greeting-u1',
    name: 'greeting',
    data: { to: 'jane@example.com', subject: 'Hi', template: 'greeting', context: {} },
    attemptsMade: overrides.attemptsMade ?? 1,
    opts: { attempts: overrides.attempts ?? 7 },
  } as unknown as Job<MailJobData, void, string>;
}

describe('MailProcessor', () => {
  it('names the counter mail_jobs_total', () => {
    expect(MAIL_JOBS_TOTAL).toBe('mail_jobs_total');
  });

  it('delivers the job payload via MailService.sendNow', async () => {
    const { mail, processor } = setup();

    await processor.process(job());

    expect(mail.sendNow).toHaveBeenCalledWith(job().data);
  });

  it('rethrows transient failures so BullMQ retries with backoff', async () => {
    const transient = Object.assign(new Error('Greylisted'), { responseCode: 451 });
    const { processor } = setup(() => Promise.reject(transient));

    await expect(processor.process(job())).rejects.toBe(transient);
  });

  it.each<[string, Error]>([
    ['template bug', new Handlebars.Exception('"displayName" not defined in [object Object]')],
    ['SMTP 550', Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 })],
  ])('fails permanently (no retry) on a %s', async (_label, error) => {
    const { processor } = setup(() => Promise.reject(error));

    await expect(processor.process(job())).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('applies MAIL_QUEUE_CONCURRENCY to the live worker at bootstrap', () => {
    const { processor } = setup();
    const worker = { concurrency: 5 };
    Object.defineProperty(processor, 'worker', { get: () => worker });

    processor.onApplicationBootstrap();

    expect(worker.concurrency).toBe(12);
  });

  it('logs retries as warnings and the final failure as an error, masking the recipient', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { processor } = setup();

    processor.onFailed(job({ attemptsMade: 1 }), new Error('timeout'));
    processor.onFailed(job({ attemptsMade: 7 }), new Error('timeout'));
    processor.onFailed(job({ attemptsMade: 1 }), new UnrecoverableError('bad template'));

    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledTimes(2);
    const logged = [...warn.mock.calls, ...error.mock.calls].map((c) => String(c[0]));
    expect(logged.join('\n')).not.toContain('jane@example.com');
    expect(logged[0]).toContain('attempt 1/7');
  });

  it('logs worker connection errors through the Nest logger, throttled (no console.error)', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { processor } = setup();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      processor.onError(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    }

    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]?.[0])).toContain('connect ECONNREFUSED');
  });

  describe('mail_jobs_total{outcome}', () => {
    it('creates every outcome at 0 at start, so the first failure is an increase for increase()', () => {
      const { inc } = setup();

      expect(inc.mock.calls).toEqual([
        [{ outcome: 'sent' }, 0],
        [{ outcome: 'retried' }, 0],
        [{ outcome: 'failed' }, 0],
      ]);
    });

    it('counts a delivered job as sent, once', async () => {
      const { processor, counted } = setup();

      await processor.process(job());

      expect(counted()).toEqual(['sent']);
    });

    it('counts nothing when delivery throws (the failed event decides the outcome)', async () => {
      const { processor, counted } = setup(() => Promise.reject(new Error('timeout')));

      await expect(processor.process(job())).rejects.toThrow('timeout');

      expect(counted()).toEqual([]);
    });

    it('counts a failed attempt with attempts left as retried, once', () => {
      const { processor, counted } = setup();

      processor.onFailed(job({ attemptsMade: 1 }), new Error('timeout'));

      expect(counted()).toEqual(['retried']);
    });

    it('counts a job out of attempts as failed, once', () => {
      const { processor, counted } = setup();

      processor.onFailed(job({ attemptsMade: 7 }), new Error('timeout'));

      expect(counted()).toEqual(['failed']);
    });

    it('counts a permanent error as failed on its first attempt', () => {
      const { processor, counted } = setup();

      processor.onFailed(job({ attemptsMade: 1 }), new UnrecoverableError('bad template'));

      expect(counted()).toEqual(['failed']);
    });

    it('counts a failure without a job (a stalled job BullMQ gave up on) as failed', () => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { processor, counted } = setup();

      processor.onFailed(undefined, new Error('job stalled more than allowable limit'));

      expect(counted()).toEqual(['failed']);
    });
  });
});
