/*
 * No imports on purpose: `billing.schema.ts` (loaded by drizzle-kit's own loader) imports this
 * file, and schema files may only depend on drizzle-orm and dependency-free relative files.
 */

/**
 * Lifecycle of a payment:
 * `pending` → `succeeded` (Checkout paid) | `expired` (session expired unpaid) | `failed`
 * (session creation failed, or an async payment method was declined). `failed` → `pending` only
 * when the same idempotent checkout request is retried. After payment (Stripe money webhooks,
 * L-11): every refund event (`charge.refunded`, `refund.updated`, `refund.failed`) stores Stripe's
 * current refunded total of the charge, and `succeeded` | `partially_refunded` | `refunded` take
 * the status it gives (0 → `succeeded`, below the amount → `partially_refunded`, else
 * `refunded`); `succeeded` | `partially_refunded` → `disputed` (`charge.dispute.funds_withdrawn`);
 * `disputed` → the status the stored total gives (`charge.dispute.funds_reinstated`).
 */
export enum PaymentStatus {
  Pending = 'pending',
  Succeeded = 'succeeded',
  Failed = 'failed',
  Expired = 'expired',
  /** Fully refunded (ledger design S-6; set by the refund webhooks of L-11). */
  Refunded = 'refunded',
  PartiallyRefunded = 'partially_refunded',
  /** A dispute (chargeback) is open or lost. */
  Disputed = 'disputed',
}

/** Ordered values, for the Postgres enum, zod and docs. */
export const PAYMENT_STATUSES = [
  PaymentStatus.Pending,
  PaymentStatus.Succeeded,
  PaymentStatus.Failed,
  PaymentStatus.Expired,
  PaymentStatus.Refunded,
  PaymentStatus.PartiallyRefunded,
  PaymentStatus.Disputed,
] as const;

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return (PAYMENT_STATUSES as readonly unknown[]).includes(value);
}
