import { type BaseMailContext, defineMail } from '@platform/mailer';

/**
 * The notifications mail templates: file names (without `.hbs`) in
 * `NOTIFICATIONS_MAIL_TEMPLATES_DIR`. They are also the BullMQ job names: keep them stable.
 */
export const NOTIFICATIONS_MAIL_TEMPLATES = ['welcome', 'payment-receipt', 'daily-digest'] as const;
export type NotificationsMailTemplate = (typeof NOTIFICATIONS_MAIL_TEMPLATES)[number];

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

/** Template → context: what `defineNotificationsMail` checks each mail against. */
export interface NotificationsMailContextMap {
  welcome: WelcomeMailContext;
  'payment-receipt': PaymentReceiptMailContext;
  'daily-digest': DailyDigestMailContext;
}

/** Builds a `MailMessage` for a notifications template, its `context` type-checked against it. */
export const defineNotificationsMail = defineMail<NotificationsMailContextMap>();
