import type { JobsOptions } from 'bullmq';

/**
 * A templated mail. Rendered with Handlebars (`strict`), so misspelled variables fail loudly.
 * `TTemplate` narrows the template name for typed builders (`defineMail`); `MailService` takes any.
 */
export interface MailMessage<TTemplate extends string = string> {
  /** Recipient address. */
  to: string;
  subject: string;
  /** File name (without `.hbs`) of a template in one of the registered template dirs. */
  template: TTemplate;
  /**
   * Template variables. `appName` and `year` are filled in by default (`BaseMailContext`); the
   * domain that owns the template declares what else it reads.
   */
  context: Record<string, unknown>;
  /**
   * Deduplicates `enqueue()`: the same key within the retention window (24h) sends one mail.
   * Derive it from the business event, e.g. `order-confirmed-${orderId}`.
   */
  idempotencyKey?: string;
}

/** Payload stored in the BullMQ job (the idempotency key is carried by the job id). */
export type MailJobData = Omit<MailMessage, 'idempotencyKey'>;

/** Variables shared by every template (layout partials). */
export interface BaseMailContext {
  /** Product name in header/footer. Default: display name of `MAIL_FROM`. */
  appName?: string;
  /** Footer copyright year. Default: current year. */
  year?: number;
  /** Where "Open the app" buttons point to (omitted → no button). */
  appUrl?: string;
}

/**
 * A `MailMessage` whose `context` is checked against `TContextMap[TTemplate]`, where `TContextMap`
 * is one domain's template → context map (see `defineMail`).
 */
export interface TypedMailMessage<TContextMap, TTemplate extends keyof TContextMap & string>
  extends Omit<MailMessage<TTemplate>, 'context'> {
  context: TContextMap[TTemplate];
}

/**
 * Overrides of the retention in `MAIL_JOB_OPTIONS`, for mails whose job data is a secret (one-time
 * codes, invitation tokens): `{ removeOnComplete: true, removeOnFail: true }` deletes the job as soon
 * as it is sent or gives up. The idempotency window then ends with the job.
 */
export type MailJobRetention = Pick<JobsOptions, 'removeOnComplete' | 'removeOnFail'>;
