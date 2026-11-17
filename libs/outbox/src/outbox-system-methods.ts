import { defineSystemMethod } from '@platform/database';

/**
 * The outbox's system methods (spec §9 item 6 plus the purge, ruling 1 of the outbox plan): the
 * only ways an `OutboxSystemRepository` reaches the `app_system` pool. All are `system` scope (the
 * relay and the reconciliation run inside `SystemContext`). Every domain with an outbox lists the
 * ones it uses in its own pinned list (identity: poll, mark, purge; billing: all four).
 */
export const OUTBOX_SYSTEM_METHODS = Object.freeze({
  /** The relay's multi-shard read of the oldest unpublished rows, with the backlog statistics. */
  poll: defineSystemMethod('outbox.pollUnpublished', 'system'),
  /** The relay stamps the rows the broker acknowledged: router statements only. */
  markPublished: defineSystemMethod('outbox.markPublished', 'system'),
  /** Platform-tenant rows (no principal can write them): `PLATFORM_TENANT_ID` records only. */
  insertAsPlatform: defineSystemMethod('outbox.insertAsPlatform', 'system'),
  /** The relay's retention purge of published rows, on every shard. */
  deletePublishedBefore: defineSystemMethod('outbox.deletePublishedBefore', 'system'),
});
