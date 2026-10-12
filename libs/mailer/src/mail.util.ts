import type { Logger } from '@nestjs/common';
import { sha256Hex } from '@platform/common';
import { throttle, trim } from 'lodash-es';
import type { BaseMailContext, MailMessage, TypedMailMessage } from './mail.types.js';
import { DEFAULT_MAIL_APP_NAME } from './mailer.constants.js';

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
 * Formats an amount in minor units (cents for USD), e.g.
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

/** Shallow copy typed as the plain record a `MailMessage` carries. */
const toContextRecord = (context: object): Record<string, unknown> => ({ ...context });

/**
 * Returns a `MailMessage` builder for one domain's templates. `context` is type-checked against the
 * template the mail names, through the domain's template → context map. Bind it once per domain,
 * e.g. `export const defineOrdersMail = defineMail<OrdersMailContextMap>();`. Optional sugar:
 * `MailService` accepts any `MailMessage`.
 */
export function defineMail<TContextMap extends Record<keyof TContextMap, object>>(): <
  TTemplate extends keyof TContextMap & string,
>(
  mail: TypedMailMessage<TContextMap, TTemplate>,
) => MailMessage<TTemplate> {
  return (mail) => {
    const { context, ...rest } = mail;
    return { ...rest, context: toContextRecord(context) };
  };
}

/** Minimum gap between two logged BullMQ connection errors (same as the ioredis clients). */
export const BULL_ERROR_LOG_INTERVAL_MS = 5_000;

/**
 * `error` listener for a BullMQ `Queue` or `Worker`. Without one, BullMQ falls back to
 * `console.error(err)`: a raw multi-line stack that bypasses pino and LOG_LEVEL, printed for every
 * reconnect attempt of every connection during a Redis outage. This logs through the Nest logger
 * instead, at most once per `intervalMs` (each listener throttles on its own).
 */
export function createThrottledErrorLog(
  logger: Logger,
  source: string,
  intervalMs: number = BULL_ERROR_LOG_INTERVAL_MS,
): (error: Error) => void {
  return throttle(
    (error: Error): void => {
      logger.error(`${source}: ${error.message}`);
    },
    intervalMs,
    { trailing: false },
  );
}
