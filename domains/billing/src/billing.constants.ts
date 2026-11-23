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
  /**
   * 403: a ledger post or read names a tenant other than the principal's (or the platform tenant
   * outside `SystemContext`), or runs with neither a principal nor `SystemContext`.
   */
  LEDGER_TENANT_MISMATCH: 'LEDGER_TENANT_MISMATCH',
  /** 503: the ledger is not enabled in this process (`LEDGER_ENABLED=false`). */
  LEDGER_DISABLED: 'LEDGER_DISABLED',
} as const;
export type BillingErrorCode = (typeof BillingErrorCode)[keyof typeof BillingErrorCode];

export const BILLING_LIMITS = {
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  MAX_QUANTITY: 100,
  PRICE_ID_MAX_LENGTH: 255,
} as const;

/**
 * `stripe_events` retention. The table only dedupes redeliveries, and Stripe retries a webhook
 * for up to 3 days; 30 days leaves ample margin (manual "resend" from the dashboard included).
 */
export const STRIPE_EVENTS_RETENTION_DAYS = 30;
/** Hourly purge of old `stripe_events`, on one replica only (`@WithLock`). */
export const PURGE_STRIPE_EVENTS_LOCK = 'billing:purge-stripe-events';
export const PURGE_STRIPE_EVENTS_LOCK_TTL_MS = 60_000;

/**
 * Hourly ledger reconciliation (R1-R3, outbox plan Task 15), on one replica only (`@WithLock`; the
 * lock is auto-extended while the run lasts).
 */
export const RECONCILE_LEDGER_LOCK = 'billing:reconcile-ledger';
export const RECONCILE_LEDGER_LOCK_TTL_MS = 120_000;
/**
 * The reconciliation window ends this long before now (plan delta 8): postings of the last
 * minutes may still be on their way through the outbox and the consumer.
 */
export const LEDGER_RECONCILE_GRACE_MS = 900_000;

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
 * Prometheus counter: paid Checkout Sessions (`checkout.session.completed` or
 * `checkout.session.async_payment_succeeded`, not unpaid) recorded without an owner: a pre-B2
 * session, a nil-UUID user, or metadata that is no tenant or user UUID. Counted on the first
 * delivery only. The amount is known but no payment is applied (it stays `pending`, no receipt):
 * alert on any increase and reconcile it against the Stripe dashboard.
 */
export const PAID_WITHOUT_OWNER_METRIC = 'billing_checkout_paid_without_owner_total';

/**
 * Prometheus counter: paid Checkout Sessions whose charged amount or currency differs from the quote
 * stored at session creation (promotion codes, tax, price changes). The charged values are recorded;
 * reconcile any increase (ledger reconciliation R3 later writes a discrepancy row).
 */
export const AMOUNT_MISMATCH_METRIC = 'billing_checkout_amount_mismatch_total';
/** Prometheus counter: webhook events whose `api_version` differs from `STRIPE_API_VERSION`. */
export const API_VERSION_MISMATCH_METRIC = 'billing_stripe_api_version_mismatch_total';
/**
 * Prometheus counter: checkout requests that sent no `Idempotency-Key` (S-4b). The header stays
 * optional; this shows how many clients skip it (each such request makes a new payment).
 */
export const CHECKOUT_WITHOUT_IDEMPOTENCY_KEY_METRIC =
  'billing_checkout_without_idempotency_key_total';

/** gRPC circuit-breaker / operation names (logs, metrics). */
export const BILLING_GRPC_UPSTREAM = 'billing';
/**
 * The gateway's second billing breaker, for the calls that wait on Stripe (`CreateCheckoutSession`,
 * `HandleStripeWebhook`): slow Stripe calls open it without cutting off `ListPayments`, and the
 * reverse.
 */
export const BILLING_GRPC_STRIPE_UPSTREAM = 'billing-stripe';

/** Header carrying Stripe's webhook signature (lower-case: Node lower-cases incoming header names). */
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';
