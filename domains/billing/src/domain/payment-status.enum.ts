/*
 * No imports on purpose: `billing.schema.ts` (loaded by drizzle-kit's own loader) imports this
 * file, and schema files may only depend on drizzle-orm and dependency-free relative files.
 */

/**
 * Lifecycle of a payment:
 * `pending` → `succeeded` (Checkout paid) | `expired` (session expired unpaid) | `failed`
 * (session creation failed, or an async payment method was declined). `failed` → `pending` only
 * when the same idempotent checkout request is retried.
 */
export enum PaymentStatus {
  Pending = 'pending',
  Succeeded = 'succeeded',
  Failed = 'failed',
  Expired = 'expired',
}

/** Ordered values, for the Postgres enum, zod and docs. */
export const PAYMENT_STATUSES = [
  PaymentStatus.Pending,
  PaymentStatus.Succeeded,
  PaymentStatus.Failed,
  PaymentStatus.Expired,
] as const;

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return (PAYMENT_STATUSES as readonly unknown[]).includes(value);
}
