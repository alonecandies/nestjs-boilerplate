export interface StripeEventReceipt {
  /** Tenant and user from the signed metadata (`stripeOwnerOf`). */
  tenantId: string;
  userId: string | null;
  id: string;
  type: string;
}

/**
 * Idempotency ledger of processed Stripe webhook events, as the event's user (implemented by
 * Drizzle on the runtime pool, under RLS). Events without a user, and the purge, go through
 * `StripeEventsSystemRepository`.
 */
export abstract class StripeEventsRepository {
  /**
   * Records the event as processed (`INSERT … ON CONFLICT DO NOTHING`). Returns `true` on the
   * first delivery and `false` for a duplicate. Call it inside the transaction that applies the
   * event: a rollback then also forgets the event, so Stripe's retry is processed again.
   * A concurrent duplicate blocks on the primary key until the first transaction ends. The policy
   * accepts only the principal's own tenant and user: a platform or user-less receipt is refused.
   */
  abstract markProcessed(event: StripeEventReceipt): Promise<boolean>;
}
