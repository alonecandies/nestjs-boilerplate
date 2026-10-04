import { mailConfig } from '@app/config';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MailerModule, MailerService } from '@nestjs-modules/mailer';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { MailService } from './mail.service.js';
import type { MailJobData } from './mail.types.js';
import { MAIL_JOB_OPTIONS, type MailTemplate } from './mailer.constants.js';
import { createMailerOptions } from './mailer-options.factory.js';

const cfg = mailConfig.parse({ MAIL_FROM: '"Acme" <no-reply@acme.test>' });

function createQueue(): Queue<MailJobData, void, MailTemplate> & {
  add: ReturnType<typeof vi.fn>;
} {
  const add = vi.fn(async (_name: string, _data: MailJobData, opts?: { jobId?: string }) => ({
    id: opts?.jobId ?? 'auto-1',
  }));
  return { add } as unknown as Queue<MailJobData, void, MailTemplate> & {
    add: ReturnType<typeof vi.fn>;
  };
}

function createMailer(): MailerService & { sendMail: ReturnType<typeof vi.fn> } {
  const sendMail = vi.fn(async () => ({ messageId: '<m1@acme.test>' }));
  return { sendMail } as unknown as MailerService & { sendMail: ReturnType<typeof vi.fn> };
}

const welcome = {
  to: 'jane@example.com',
  subject: 'Welcome!',
  template: 'welcome',
  context: { displayName: 'Jane' },
} as const;

describe('MailService.enqueue', () => {
  it('adds a job named after the template with the mail job options', async () => {
    const queue = createQueue();
    const service = new MailService(queue, createMailer(), cfg);

    const result = await service.enqueue({ ...welcome, idempotencyKey: 'welcome-0199a3c1' });

    expect(queue.add).toHaveBeenCalledWith(
      'welcome',
      {
        to: 'jane@example.com',
        subject: 'Welcome!',
        template: 'welcome',
        context: welcome.context,
      },
      { ...MAIL_JOB_OPTIONS, jobId: 'welcome-0199a3c1' },
    );
    expect(result).toEqual({ jobId: 'welcome-0199a3c1' });
  });

  it('never stores the idempotency key in the job payload', async () => {
    const queue = createQueue();

    await new MailService(queue, createMailer(), cfg).enqueue({ ...welcome, idempotencyKey: 'k1' });

    expect(queue.add.mock.calls[0]?.[1]).not.toHaveProperty('idempotencyKey');
  });

  it('hashes keys BullMQ would reject (":" or integer strings) deterministically', async () => {
    const queue = createQueue();
    const service = new MailService(queue, createMailer(), cfg);

    await service.enqueue({ ...welcome, idempotencyKey: 'receipt:pay_1' });
    await service.enqueue({ ...welcome, idempotencyKey: 'receipt:pay_1' });
    await service.enqueue({ ...welcome, idempotencyKey: '12345' });

    const [first, second, third] = queue.add.mock.calls.map(
      (c) => (c[2] as { jobId: string }).jobId,
    );
    expect(first).toMatch(/^k-[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(third).toMatch(/^k-[0-9a-f]{64}$/);
  });

  it('lets BullMQ generate the id without a key', async () => {
    const queue = createQueue();

    const result = await new MailService(queue, createMailer(), cfg).enqueue(welcome);

    expect(queue.add.mock.calls[0]?.[2]).not.toHaveProperty('jobId');
    expect(result.jobId).toBe('auto-1');
  });
});

describe('MailService.sendNow', () => {
  it('merges default context (appName from MAIL_FROM, year) under the caller context', async () => {
    const mailer = createMailer();

    await new MailService(createQueue(), mailer, cfg).sendNow({
      ...welcome,
      context: { displayName: 'Jane', appName: 'Override' },
    });

    expect(mailer.sendMail).toHaveBeenCalledWith({
      to: 'jane@example.com',
      subject: 'Welcome!',
      template: 'welcome',
      context: { appName: 'Override', year: new Date().getUTCFullYear(), displayName: 'Jane' },
    });
  });

  it('renders the real template through MailerService + HandlebarsAdapter (JSON transport)', async () => {
    @Module({
      imports: [
        MailerModule.forRootAsync({
          imports: [],
          useFactory: () => ({ ...createMailerOptions(cfg), transport: { jsonTransport: true } }),
        }),
      ],
    })
    class TestMailModule {}
    const app = await NestFactory.createApplicationContext(TestMailModule, { logger: false });
    try {
      const mailer = app.get(MailerService);
      const send = vi.spyOn(mailer, 'sendMail');

      await new MailService(createQueue(), mailer, cfg).sendNow({
        to: 'jane@example.com',
        subject: 'Your receipt',
        template: 'payment-receipt',
        context: { paymentId: 'pay_1', amount: '$19.99', paidAt: '2026-09-29' },
      });

      const info = (await send.mock.results[0]?.value) as { message: string };
      const message = JSON.parse(info.message) as {
        from: { address: string; name: string };
        subject: string;
        html: string;
      };
      expect(message.from).toEqual({ address: 'no-reply@acme.test', name: 'Acme' });
      expect(message.subject).toBe('Your receipt');
      expect(message.html).toContain('We received your payment of $19.99.');
      expect(message.html).toContain(`&copy; ${new Date().getUTCFullYear()} Acme`);
    } finally {
      await app.close();
    }
  });
});
