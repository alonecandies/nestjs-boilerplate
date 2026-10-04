import { sha256Hex } from '@app/common';
import { trim } from 'lodash-es';
import type { BaseMailContext, MailMessage, MailTemplateContextMap } from './mail.types.js';
import { DEFAULT_MAIL_APP_NAME, type MailTemplate } from './mailer.constants.js';

// BullMQ rejects custom job ids containing ':' (they collide with its key layout) and ids that
// are integer strings (they collide with auto-generated ids).
const SAFE_JOB_ID = /^[A-Za-z0-9._-]{1,128}$/;
const INTEGER = /^\d+$/;

/**
 * Maps an idempotency key to a valid BullMQ job id. Safe keys are used verbatim (readable in
 * dashboards). Anything else is hashed to `k-<sha256>`, which is deterministic and so still
 * deduplicates. Keys are never rejected, because a mail must not fail over its dedup key.
 */
export function toMailJobId(idempotencyKey: string): string {
  return SAFE_JOB_ID.test(idempotencyKey) && !INTEGER.test(idempotencyKey)
    ? idempotencyKey
    : `k-${sha256Hex(idempotencyKey)}`;
}

/** Display name of an RFC 5322 address (`"Acme" <no-reply@acme.io>` → `Acme`), if any. */
export function mailFromName(from: string): string | undefined {
  const match = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(from);
  const name = trim(match?.[1] ?? '');
  return name === '' ? undefined : name;
}

/** Variables every template may use. Callers' `context` values win. */
export function defaultMailContext(
  from: string,
  now: Date = new Date(),
): Required<Pick<BaseMailContext, 'appName' | 'year'>> {
  return { appName: mailFromName(from) ?? DEFAULT_MAIL_APP_NAME, year: now.getUTCFullYear() };
}

const moneyFormats = new Map<string, Intl.NumberFormat>();

/**
 * Formats an amount in minor units (Stripe/`PaymentSucceededPayload.amountTotal`), e.g.
 * `formatMoney(1999, 'usd')` → `$19.99` and `formatMoney(500, 'jpy')` → `¥500`. The number of
 * decimals comes from the currency. Formatters are cached, because building an `Intl` formatter
 * is expensive compared to using one.
 */
export function formatMoney(amountMinor: number, currency: string, locale = 'en-US'): string {
  const code = currency.toUpperCase();
  const cacheKey = `${locale}|${code}`;
  let format = moneyFormats.get(cacheKey);
  if (format === undefined) {
    format = new Intl.NumberFormat(locale, { style: 'currency', currency: code });
    moneyFormats.set(cacheKey, format);
  }
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(amountMinor / 10 ** digits);
}

/**
 * Builds a `MailMessage` whose `context` is type-checked against the template
 * (`MailTemplateContextMap`). This is optional sugar: `MailService` accepts any `MailMessage`.
 */
export function defineMail<T extends MailTemplate>(mail: {
  to: string;
  subject: string;
  template: T;
  context: MailTemplateContextMap[T];
  idempotencyKey?: string;
}): MailMessage {
  const { context, ...rest } = mail;
  return { ...rest, context: { ...context } };
}
