import { type OutboxFeature, OutboxWriter } from '@platform/outbox';
import { outbox } from './billing.schema.js';

/** Billing's outbox: the table `billing.outbox`; `name` (= the schema) names the relay lock. */
export const BILLING_OUTBOX: OutboxFeature = { name: 'billing', table: outbox };

/**
 * Billing's outbox writer (the DI token `OutboxModule.forFeature` binds to `BILLING_OUTBOX`):
 * `enqueue` inserts one integration event in the caller's open unit of work, under the
 * principal's tenant, so the event commits or rolls back with the state change it reports.
 */
export class BillingOutbox extends OutboxWriter {}
