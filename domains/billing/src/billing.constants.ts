/**
 * Stable error codes of the billing context (`DomainException.code`, surfaced to clients),
 * including its Stripe adapter's. Part of the public API: never rename a value.
 */
export const BillingErrorCode = {
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  /** 403: the request names a tenant the caller is not acting in. */
  TENANT_MISMATCH: 'TENANT_MISMATCH',
  /**
   * Same `Idempotency-Key` replayed with a different checkout request, or Stripe refusing a reused
   * idempotency key (`StripeIdempotencyError`).
   */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /** Optimistic-lock failure: the payment changed between load and save (retry the request). */
  PAYMENT_CONCURRENTLY_MODIFIED: 'PAYMENT_CONCURRENTLY_MODIFIED',
  /** A second, different Checkout Session for a payment that already has one. */
  CHECKOUT_SESSION_MISMATCH: 'CHECKOUT_SESSION_MISMATCH',
  /** Stripe created a session without a hosted URL (non-hosted ui_mode). */
  CHECKOUT_URL_MISSING: 'CHECKOUT_URL_MISSING',
  /** The same checkout request is still in flight at Stripe (`idempotency_key_in_use`): retry. */
  CHECKOUT_IN_PROGRESS: 'CHECKOUT_IN_PROGRESS',
  /** A replayed checkout request whose session is already `complete` or `expired`. */
  CHECKOUT_SESSION_CLOSED: 'CHECKOUT_SESSION_CLOSED',
  INVALID_PAYMENT: 'INVALID_PAYMENT',
  /** Missing, forged or stale (> `STRIPE_WEBHOOK_TOLERANCE_SEC`) `Stripe-Signature`. */
  INVALID_WEBHOOK_SIGNATURE: 'INVALID_WEBHOOK_SIGNATURE',
  /** Correctly signed webhook body that is not a JSON event. */
  INVALID_WEBHOOK_PAYLOAD: 'INVALID_WEBHOOK_PAYLOAD',
  /** `StripeInvalidRequestError` (e.g. an unknown price). */
  PAYMENT_REQUEST_INVALID: 'PAYMENT_REQUEST_INVALID',
  /** `StripeCardError` (`details.declineCode`). */
  PAYMENT_DECLINED: 'PAYMENT_DECLINED',
  /** `StripeRateLimitError`. */
  PAYMENT_PROVIDER_RATE_LIMITED: 'PAYMENT_PROVIDER_RATE_LIMITED',
  /** Any other Stripe failure (authentication, API, connection). */
  PAYMENT_PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
  /** A ledger draft violates the double-entry rules (programming error; never retried). */
  LEDGER_ENTRY_INVALID: 'LEDGER_ENTRY_INVALID',
  /** A ledger row failed proof verification against the trusted state. */
  LEDGER_VERIFICATION_FAILED: 'LEDGER_VERIFICATION_FAILED',
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

/**
 * Prometheus counter: Checkout Sessions Stripe reported paid without any usable currency (none in
 * the event, none stored). The payment is left `pending` and NOT announced (no receipt): alert on
 * any increase and reconcile it against the Stripe dashboard.
 */
export const PAID_WITHOUT_CURRENCY_METRIC = 'billing_checkout_paid_without_currency_total';

/**
 * Prometheus counter: Checkout Sessions Stripe reported paid without any amount (none in the event,
 * none stored, for example when the session was never bound). The payment is left `pending` and NOT
 * announced: alert on any increase and reconcile it against the Stripe dashboard.
 */
export const PAID_WITHOUT_AMOUNT_METRIC = 'billing_checkout_paid_without_amount_total';

/**
 * Prometheus counter: paid Checkout Sessions whose charged amount or currency differs from the quote
 * stored at session creation (promotion codes, tax, price changes). The charged values are recorded;
 * reconcile any increase (ledger reconciliation R3 later writes a discrepancy row).
 */
export const AMOUNT_MISMATCH_METRIC = 'billing_checkout_amount_mismatch_total';
/** Prometheus counter: webhook events whose `api_version` differs from `STRIPE_API_VERSION`. */
export const API_VERSION_MISMATCH_METRIC = 'billing_stripe_api_version_mismatch_total';

/** gRPC circuit-breaker / operation names (logs, metrics). */
export const BILLING_GRPC_UPSTREAM = 'billing';

/** Header carrying Stripe's webhook signature (lower-case: Node lower-cases incoming header names). */
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';
