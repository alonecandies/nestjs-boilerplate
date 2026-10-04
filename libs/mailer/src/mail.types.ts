import type { MailTemplate } from './mailer.constants.js';

/** A templated mail. Rendered with Handlebars (`strict`), so misspelled variables fail loudly. */
export interface MailMessage {
  /** Recipient address. */
  to: string;
  subject: string;
  template: MailTemplate;
  /**
   * Template variables. `appName` and `year` are filled in by default. See `WelcomeMailContext`,
   * `PaymentReceiptMailContext` and `DailyDigestMailContext` for what each template reads.
   */
  context: Record<string, unknown>;
  /**
   * Deduplicates `enqueue()`: the same key within the retention window (24h) sends one mail.
   * Derive it from the business event, e.g. `welcome-${userId}` or `receipt-${paymentId}`.
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

/** `welcome.hbs` */
export interface WelcomeMailContext extends BaseMailContext {
  displayName: string;
}

/** `payment-receipt.hbs` */
export interface PaymentReceiptMailContext extends BaseMailContext {
  displayName?: string;
  paymentId: string;
  /** Pre-formatted amount incl. currency, e.g. `formatMoney(1999, 'usd')` → `$19.99`. */
  amount: string;
  /** ISO-8601 or pre-formatted date. */
  paidAt: string;
  description?: string;
}

/** One line of `daily-digest.hbs`. */
export interface DigestItem {
  title: string;
  body: string;
  createdAt: string;
}

/** `daily-digest.hbs` */
export interface DailyDigestMailContext extends BaseMailContext {
  displayName?: string;
  unreadCount: number;
  items: DigestItem[];
}

/** Template → context type, for callers that want compile-time checked contexts. */
export interface MailTemplateContextMap {
  welcome: WelcomeMailContext;
  'payment-receipt': PaymentReceiptMailContext;
  'daily-digest': DailyDigestMailContext;
}
