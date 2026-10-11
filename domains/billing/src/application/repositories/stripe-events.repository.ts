export interface StripeEventReceipt {
  id: string;
  type: string;
}

/** Idempotency ledger of processed Stripe webhook events (implemented by Drizzle). */
export abstract class StripeEventsRepository {
  /**
   * Records the event as processed (`INSERT … ON CONFLICT DO NOTHING`). Returns `true` on the
   * first delivery and `false` for a duplicate. Call it inside the transaction that applies the
   * event: a rollback then also forgets the event, so Stripe's retry is processed again.
   * A concurrent duplicate blocks on the primary key until the first transaction ends.
   */
  abstract markProcessed(event: StripeEventReceipt): Promise<boolean>;

  /**
   * Deletes at most `limit` events processed before `cutoff` (one short statement, backed by the
   * `processed_at` index) and returns how many rows went. Callers loop until a partial batch.
   */
  abstract deleteProcessedBefore(cutoff: Date, limit: number): Promise<number>;
}
