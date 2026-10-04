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

/** gRPC circuit-breaker / operation names (logs, metrics). */
export const BILLING_GRPC_UPSTREAM = 'billing';
