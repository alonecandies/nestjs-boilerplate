import { maskEmail } from '@app/common';
import { type MailConfig, mailConfig } from '@app/config';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { isPermanentMailError } from './mail.errors.js';
import { MailService } from './mail.service.js';
import type { MailJobData } from './mail.types.js';
import { DEFAULT_MAIL_CONCURRENCY, MAIL_QUEUE, type MailTemplate } from './mailer.constants.js';

type MailJob = Job<MailJobData, void, MailTemplate>;

/**
 * BullMQ worker for the `mail` queue. Register it only in processes that should deliver mail
 * (`AppMailerModule.forRootAsync({ worker: true })`, e.g. notifications-service). Producers can
 * enqueue from anywhere.
 */
@Processor(MAIL_QUEUE, { concurrency: DEFAULT_MAIL_CONCURRENCY })
export class MailProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(MailProcessor.name);

  constructor(
    private readonly mail: MailService,
    @Inject(mailConfig.KEY) private readonly cfg: MailConfig,
  ) {
    super();
  }

  /**
   * `@Processor` options are static, so the configured concurrency (`MAIL_QUEUE_CONCURRENCY`) is
   * applied to the live worker here. The worker exists at this point: BullMQ's explorer creates
   * it in `onModuleInit`.
   */
  onApplicationBootstrap(): void {
    this.worker.concurrency = this.cfg.queueConcurrency;
  }

  override async process(job: MailJob): Promise<void> {
    try {
      await this.mail.sendNow(job.data);
    } catch (error) {
      if (!isPermanentMailError(error)) throw error;
      // No retry can fix a template bug or a permanent SMTP rejection, so the job fails now.
      throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: MailJob | undefined, error: Error): void {
    if (job === undefined) {
      this.logger.error(`Mail job failed: ${error.message}`);
      return;
    }
    const attempts = job.opts.attempts ?? 1;
    // Recipients are masked: logs are not a place for personal data.
    const summary = `"${job.name}" mail to ${maskEmail(job.data.to)} (job ${job.id ?? 'n/a'}, attempt ${job.attemptsMade}/${attempts})`;
    const final = error instanceof UnrecoverableError || job.attemptsMade >= attempts;
    if (final) this.logger.error(`Giving up on ${summary}: ${error.message}`);
    else this.logger.warn(`Retrying ${summary}: ${error.message}`);
  }
}
