import { Command } from '@nestjs/cqrs';

export interface SendDailyDigestOptions {
  /** Upper bound of recipients inspected in this run. */
  maxRecipients?: number;
  /** Clock override (tests); also the day in the idempotency key. */
  now?: Date;
}

export interface DailyDigestResult {
  /** Recipients inspected. */
  scanned: number;
  /** Digest mails queued (recipients with at least one unread notification). */
  enqueued: number;
  /** Recipients whose digest failed (logged; the run continues). */
  failed: number;
}

/** Queues one digest mail per recipient that has unread notifications (at most once a day). */
export class SendDailyDigestCommand extends Command<DailyDigestResult> {
  constructor(readonly options: SendDailyDigestOptions = {}) {
    super();
  }
}
