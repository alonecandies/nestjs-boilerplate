import { InMemoryOutbox, type InMemoryOutboxOptions } from '@platform/outbox/testing';
import { BILLING_OUTBOX } from '../infrastructure/persistence/billing-outbox.js';

/**
 * Billing's outbox in memory (`InMemoryOutbox` over `BILLING_OUTBOX`): bind the one object as
 * `BillingOutbox` and as `BillingOutboxSystemRepository`, and drive the relay with `tick()`.
 * Without `options.txHost` every enqueue counts as inside a transaction (inline runners).
 */
export function createInMemoryBillingOutbox(options: InMemoryOutboxOptions = {}): InMemoryOutbox {
  return new InMemoryOutbox(BILLING_OUTBOX, options);
}
