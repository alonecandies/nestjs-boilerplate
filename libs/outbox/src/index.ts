/**
 * @platform/outbox — the transactional outbox, naming no domain. Each Postgres domain declares its
 * own `<schema>.outbox` table (the `OutboxTable` shape) and an `OutboxFeature`, subclasses
 * `OutboxWriter` once (its DI token) and enqueues integration events in the transaction that
 * changes state; the relay publishes them with `KafkaProducer.publishStored`.
 * - `OutboxWriter`: `record()` (a validated record, no SQL) and `enqueue()` (one plain INSERT in
 *   the caller's open transaction, the principal's tenant).
 * - `OutboxError`, `OutboxTable`, `OutboxFeature`, `OutboxRecord`, `OutboxRow`, `OutboxPoll`.
 * - `@platform/outbox/testing`: `InMemoryOutbox`, `describeOutboxTable`.
 */
export * from './outbox.errors.js';
export * from './outbox.types.js';
export * from './outbox-writer.js';
