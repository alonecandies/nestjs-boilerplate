import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { type MailConfig, mailConfig } from '@platform/config';
import { Queue } from 'bullmq';
import type { MailJobData, MailJobRetention, MailMessage } from './mail.types.js';
import { createThrottledErrorLog, defaultMailContext, toMailJobId } from './mail.util.js';
import {
  MAIL_JOB_OPTIONS,
  MAIL_QUEUE,
  MAIL_SENT_MARKER_PREFIX,
  MAIL_SENT_MARKER_TTL_SEC,
} from './mailer.constants.js';

/**
 * Result of `enqueue`: the BullMQ job id (derived from the idempotency key when one was given, also
 * when the mail was already enqueued and nothing was added).
 */
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
    @InjectQueue(MAIL_QUEUE) private readonly queue: Queue<MailJobData, void, string>,
    private readonly mailer: MailerService,
    @Inject(mailConfig.KEY) private readonly cfg: MailConfig,
  ) {
    this.queue.on('error', createThrottledErrorLog(this.logger, 'Mail queue error'));
  }

  /**
   * Adds the mail to the `mail` queue. The job is named after the template, which makes queue
   * dashboards readable. `retention` shortens how long the job (and its data) stays in Redis.
   *
   * With an `idempotencyKey`, a second enqueue is a no-op for 14 days, the `.dlq` retention: this is
   * what makes redelivered and replayed events safe. While the job is kept (24h, or the last 10,000
   * completed) its job id deduplicates; after that, the sent marker does
   * (`MAIL_SENT_MARKER_PREFIX`, in the queue's own Redis and key space). Check, add, then set: a
   * crash between the add and the set is still covered by the job id.
   */
  async enqueue(mail: MailMessage, retention?: MailJobRetention): Promise<EnqueuedMail> {
    const { idempotencyKey, ...data } = mail;
    if (idempotencyKey === undefined) {
      return this.add(data, retention);
    }
    const jobId = toMailJobId(idempotencyKey);
    const marker = this.queue.toKey(`${MAIL_SENT_MARKER_PREFIX}${jobId}`);
    const redis = await this.queue.getBackend().client;
    if ((await redis.get(marker)) !== null) {
      this.logger.debug(`Skipped "${data.template}" mail: job ${jobId} was already enqueued`);
      return { jobId };
    }
    const enqueued = await this.add(data, retention, jobId);
    await redis.set(marker, '1', { EX: MAIL_SENT_MARKER_TTL_SEC });
    return enqueued;
  }

  private async add(
    data: MailJobData,
    retention: MailJobRetention | undefined,
    jobId?: string,
  ): Promise<EnqueuedMail> {
    const job = await this.queue.add(data.template, data, {
      ...MAIL_JOB_OPTIONS,
      ...retention,
      ...(jobId === undefined ? {} : { jobId }),
    });
    this.logger.debug(`Queued "${data.template}" mail (job ${job.id ?? 'n/a'})`);
    return { jobId: job.id };
  }

  /**
   * Renders and sends right away, in this process. It throws on failure and has no retry.
   * Default context (`appName`, `year`, `appUrl`) is merged under the caller's context.
   */
  async sendNow(mail: MailMessage | MailJobData): Promise<void> {
    await this.mailer.sendMail({
      to: mail.to,
      subject: mail.subject,
      template: mail.template,
      context: {
        ...defaultMailContext(this.cfg.from, new Date(), this.cfg.appUrl),
        ...mail.context,
      },
    });
  }
}
