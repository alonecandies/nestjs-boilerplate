import { SystemContext } from '@platform/common';
import { SystemDatabaseError } from '@platform/database';
import type { StripeEventReceipt } from '../application/repositories/stripe-events.repository.js';
import { StripeEventsSystemRepository } from '../application/repositories/stripe-events.system-repository.js';

/** One recorded event, with when it was processed. */
export interface InMemoryStripeEvent extends StripeEventReceipt {
  readonly processedAt: Date;
}

/**
 * `StripeEventsSystemRepository` in memory, for app e2e and flow tests: the same refusals as the
 * real one (outside `SystemContext`: SYSTEM_CONTEXT_REQUIRED; a receipt with a user: an Error),
 * idempotent per `(tenantId, id)`. `events` is readable; `seed` back-dates an event for the purge.
 */
export class InMemoryStripeEventsSystemRepository extends StripeEventsSystemRepository {
  private readonly rows = new Map<string, InMemoryStripeEvent>();

  constructor(private readonly now: () => Date = () => new Date()) {
    super();
  }

  /** Every recorded event, in insertion order. */
  get events(): readonly InMemoryStripeEvent[] {
    return [...this.rows.values()];
  }

  seed(event: StripeEventReceipt, processedAt: Date): void {
    this.rows.set(`${event.tenantId}:${event.id}`, { ...event, processedAt });
  }

  override async deleteProcessedBefore(cutoff: Date): Promise<number> {
    requireSystemContext('stripeEvents.deleteProcessedBefore');
    const expired = [...this.rows].filter(([, row]) => row.processedAt < cutoff);
    for (const [key] of expired) this.rows.delete(key);
    return expired.length;
  }

  override async markProcessedAsPlatform(event: StripeEventReceipt): Promise<boolean> {
    if (event.userId !== null) {
      throw new Error(`Stripe event ${event.id} has a user: record it as that user`);
    }
    requireSystemContext('stripeEvents.markProcessedAsPlatform');
    const key = `${event.tenantId}:${event.id}`;
    if (this.rows.has(key)) return false;
    this.rows.set(key, { ...event, processedAt: this.now() });
    return true;
  }
}

function requireSystemContext(method: string): void {
  if (!SystemContext.isActive()) {
    throw new SystemDatabaseError(
      'SYSTEM_CONTEXT_REQUIRED',
      `System method ${method} runs only inside SystemContext.run()`,
    );
  }
}
