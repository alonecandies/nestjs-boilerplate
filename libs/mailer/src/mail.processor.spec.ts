import { mailConfig } from '@app/config';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import Handlebars from 'handlebars';
import { describe, expect, it, vi } from 'vitest';
import { MailProcessor } from './mail.processor.js';
import type { MailService } from './mail.service.js';
import type { MailJobData } from './mail.types.js';
import type { MailTemplate } from './mailer.constants.js';

const cfg = mailConfig.parse({ MAIL_QUEUE_CONCURRENCY: '12' });

function setup(sendNow: () => Promise<void> = async () => undefined) {
  const mail = { sendNow: vi.fn(sendNow) } as unknown as MailService & {
    sendNow: ReturnType<typeof vi.fn>;
  };
  return { mail, processor: new MailProcessor(mail, cfg) };
}

function job(overrides: Partial<{ attemptsMade: number; attempts: number }> = {}) {
  return {
    id: 'welcome-u1',
    name: 'welcome',
    data: { to: 'jane@example.com', subject: 'Hi', template: 'welcome', context: {} },
    attemptsMade: overrides.attemptsMade ?? 1,
    opts: { attempts: overrides.attempts ?? 7 },
  } as unknown as Job<MailJobData, void, MailTemplate>;
}

describe('MailProcessor', () => {
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
});
