import { type OutboxFeature, OutboxWriter } from '@platform/outbox';
import { outbox } from './identity.schema.js';

/** Identity's outbox: the table `identity.outbox`; `name` (= the schema) names the relay lock. */
export const IDENTITY_OUTBOX: OutboxFeature = { name: 'identity', table: outbox };

/**
 * Identity's outbox writer (the DI token `OutboxModule.forFeature` binds to `IDENTITY_OUTBOX`):
 * `enqueue` inserts one integration event in the caller's open unit of work, under the
 * principal's tenant, so the event commits or rolls back with the state change it reports.
 */
export class IdentityOutbox extends OutboxWriter {}
