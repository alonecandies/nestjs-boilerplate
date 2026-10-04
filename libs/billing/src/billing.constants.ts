/** Stable error codes of the billing context (`DomainException.code`, surfaced to clients). */
export const BillingErrorCode = {
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  /** Same `Idempotency-Key` replayed with a different price/quantity. */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /** Optimistic-lock failure: the payment changed between load and save (retry the request). */
  PAYMENT_CONCURRENTLY_MODIFIED: 'PAYMENT_CONCURRENTLY_MODIFIED',
  /** A second, different Checkout Session for a payment that already has one. */
  CHECKOUT_SESSION_MISMATCH: 'CHECKOUT_SESSION_MISMATCH',
  /** Stripe created a session without a hosted URL (non-hosted ui_mode). */
  CHECKOUT_URL_MISSING: 'CHECKOUT_URL_MISSING',
  INVALID_PAYMENT: 'INVALID_PAYMENT',
} as const;
export type BillingErrorCode = (typeof BillingErrorCode)[keyof typeof BillingErrorCode];

export const BILLING_LIMITS = {
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  MAX_QUANTITY: 100,
  PRICE_ID_MAX_LENGTH: 255,
  IDEMPOTENCY_KEY_MIN_LENGTH: 8,
  IDEMPOTENCY_KEY_MAX_LENGTH: 255,
} as const;

/**
 * `Idempotency-Key` charset: printable, header- and log-safe (UUIDs, ULIDs, `order-42:retry`).
 * The key is stored per user and never forwarded to Stripe verbatim (see
 * `CreateCheckoutSessionHandler`), so no Stripe-specific constraint applies.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * `stripe_events` retention. The table only dedupes redeliveries, and Stripe retries a webhook
 * for up to 3 days; 30 days leaves ample margin (manual "resend" from the dashboard included).
 */
export const STRIPE_EVENTS_RETENTION_DAYS = 30;
/** Hourly purge of old `stripe_events`, on one replica only (`@WithLock`). */
export const PURGE_STRIPE_EVENTS_LOCK = 'billing:purge-stripe-events';
export const PURGE_STRIPE_EVENTS_LOCK_TTL_MS = 60_000;
/** Rows deleted per statement: keeps each DELETE short (row locks, WAL bursts, replication lag). */
export const PURGE_STRIPE_EVENTS_BATCH_SIZE = 5_000;

/**
 * Prometheus counter: Checkout Sessions Stripe reported paid without any usable currency (none in
 * the event, none stored). The payment is left `pending` and NOT announced (no receipt): alert on
 * any increase and reconcile it against the Stripe dashboard.
 */
export const PAID_WITHOUT_CURRENCY_METRIC = 'billing_checkout_paid_without_currency_total';

/** gRPC circuit-breaker / operation names (logs, metrics). */
export const BILLING_GRPC_UPSTREAM = 'billing';
