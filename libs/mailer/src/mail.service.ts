import { type MailConfig, mailConfig } from '@app/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { Queue } from 'bullmq';
import type { MailJobData, MailMessage } from './mail.types.js';
import { createThrottledErrorLog, defaultMailContext, toMailJobId } from './mail.util.js';
import { MAIL_JOB_OPTIONS, MAIL_QUEUE, type MailTemplate } from './mailer.constants.js';

/** Result of `enqueue`: the BullMQ job id (the idempotency key when one was given). */
export interface EnqueuedMail {
  jobId: string | undefined;
}

/**
 * Outbound mail facade. `enqueue()` is the default: the caller (an HTTP request, a Kafka
 * consumer) returns right away, and delivery is retried with backoff by `MailProcessor`, which
 * can run in another process. `sendNow()` is for the worker itself and for scripts.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  /**
   * The queue's Redis connection reports outages and reconnect attempts as `error` events. With no
   * listener BullMQ falls back to `console.error` (raw stacks outside pino, one per attempt), so
   * they are logged here instead, throttled. The listener is attached in the constructor, not in
   * `onModuleInit`: the queue starts connecting as soon as its provider is created, and a Redis
   * that is down at boot reports ECONNREFUSED while other providers (Cassandra, Postgres) are
   * still being created, long before any `onModuleInit` hook runs.
   */
  constructor(
    @InjectQueue(MAIL_QUEUE) private readonly queue: Queue<MailJobData, void, MailTemplate>,
    private readonly mailer: MailerService,
    @Inject(mailConfig.KEY) private readonly cfg: MailConfig,
  ) {
    this.queue.on('error', createThrottledErrorLog(this.logger, 'Mail queue error'));
  }

  /**
   * Adds the mail to the `mail` queue. The job is named after the template, which makes queue
   * dashboards readable. With an `idempotencyKey`, a second enqueue while the first job is still
   * retained (24h after completion) is a no-op: this is what makes redelivered events safe.
   */
  async enqueue(mail: MailMessage): Promise<EnqueuedMail> {
    const { idempotencyKey, ...data } = mail;
    const jobId = idempotencyKey === undefined ? undefined : toMailJobId(idempotencyKey);
    const job = await this.queue.add(data.template, data, {
      ...MAIL_JOB_OPTIONS,
      ...(jobId === undefined ? {} : { jobId }),
    });
    this.logger.debug(`Queued "${data.template}" mail (job ${job.id ?? 'n/a'})`);
    return { jobId: job.id };
  }

  /**
   * Renders and sends right away, in this process. It throws on failure and has no retry.
   * Default context (`appName`, `year`) is merged under the caller's context.
   */
  async sendNow(mail: MailMessage | MailJobData): Promise<void> {
    await this.mailer.sendMail({
      to: mail.to,
      subject: mail.subject,
      template: mail.template,
      context: { ...defaultMailContext(this.cfg.from), ...mail.context },
    });
  }
}
