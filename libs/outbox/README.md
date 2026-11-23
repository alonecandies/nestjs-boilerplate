# @platform/outbox

The transactional outbox. An integration event is written to `<schema>.outbox` in the transaction
that changes the state it reports, so the two commit or roll back together. A relay then publishes
the rows to Kafka, at least once. The package names no domain: each Postgres domain owns its outbox
table, migration, policy and a thin system repository.

## Public API

| Export                                                                             | Kind           | Purpose                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OutboxWriter`                                                                     | abstract class | `constructor(feature, txHost, kafka)`. Each domain subclasses it once; the subclass is the DI token.                                                                                                                                                                      |
| `OutboxWriter#record(contract, payload, options?)`                                 | method         | A validated `OutboxRecord`, no SQL. Envelopes come from `KafkaProducer.createRecord`, so tenant, actor and correlation id default the same way. Works without a transaction or principal when `options.tenantId` is given, the platform tenant included.                  |
| `OutboxWriter#enqueue(contract, payload, options?)`                                | method         | `record()` plus one plain `INSERT` (no `RETURNING`, no `ON CONFLICT`) in the caller's open transaction; it never opens one. The row's tenant is the principal's. Returns the envelope. Nothing is sent to Kafka.                                                          |
| `OutboxError`                                                                      | error          | `code`: `OUTBOX_NO_TRANSACTION` (no open transaction), `OUTBOX_TENANT_REQUIRED` (no tenant), `OUTBOX_TENANT_MISMATCH` (`options.tenantId` is not the principal's), `OUTBOX_PLATFORM_TENANT` (a runtime row for the nil tenant). A programming error: it renders as a 500. |
| `OutboxTable`, `OutboxFeature`                                                     | types          | The drizzle table type every outbox table matches, and `{ name, table }` (`name` = the Postgres schema; it also names the relay lock and metric labels).                                                                                                                  |
| `OutboxRecord`, `OutboxRow`, `OutboxPoll`                                          | types          | A stored event (`id` = envelope id, `tenantId` = envelope tenant), a polled row (`createdAt`), and one poll with its backlog statistics.                                                                                                                                  |
| `OutboxModule.forFeature({ feature, writer, systemRepository })`                   | dynamic module | Provides and exports the domain's writer (over the CLS `TransactionHost` and `KafkaProducer`) and system repository, and owns one `OutboxRelay`. One call per outbox; each call is its own module instance.                                                               |
| `OutboxRelay`                                                                      | class          | The relay of one outbox (below). `tick(signal)` runs one poll → publish → mark cycle and resolves `OutboxTickResult` `{ polled, published, failed }`; `runTerm(stop)` runs one term on the lock and resolves `'not-leader'`, `'lost'` or `'stopped'`.                     |
| `outboxRelayLockResource(name)`, `OUTBOX_RELAY_REASON`, `OUTBOX_PURGE_INTERVAL_MS` | constants      | The lock resource `outbox-relay:<name>`, the `SystemContext` reason `outbox.relay` of every relay call, and the purge period (one hour).                                                                                                                                  |

`@platform/transport` adds the send side: `KafkaProducer#publishStored(topic, envelope, key)` sends
a stored envelope unchanged (generic envelope schema and `type === topic` checked, headers rebuilt
from the envelope, nothing read from CLS).

**Trace context.** The row needs no trace column: `KafkaProducer.createRecord`, which builds every
stored envelope, adds the W3C `traceparent` and `tracestate` of the active span to the envelope
(absent without one, so an untraced envelope is unchanged). `publishStored` sends under that
context, so the kafkajs produce span of the relay's tick is a child of the request that wrote the
row, and the instrumentation injects it into the record headers for the consumers. Rows written
before this change, and envelopes with a malformed `traceparent`, go out as before, under no
trace.

## Declaring an outbox table

drizzle-kit loads schema files without workspace resolution, so each domain declares the table by
hand, exactly like this (in its own `pgSchema`), and its schema spec calls
`describeOutboxTable(outbox, '<schema>')`:

```ts
export const outbox = ordersPgSchema.table(
  'outbox',
  {
    tenantId: uuid().notNull(),
    id: uuid().notNull(),
    topic: text().notNull(),
    key: text(),
    envelope: jsonb().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    publishedAt: timestamptz(),
  },
  (t) => [
    primaryKey({ name: 'outbox_tenant_id_id_pk', columns: [t.tenantId, t.id] }),
    index('outbox_unpublished_idx')
      .on(t.createdAt, t.id)
      .where(sql`${t.publishedAt} IS NULL`),
    index('outbox_published_at_idx')
      .on(t.publishedAt)
      .where(sql`${t.publishedAt} IS NOT NULL`),
  ],
);
```

The migration distributes it by `tenant_id`, enables and forces RLS, grants `INSERT` to
`app_runtime` (no `SELECT`: runtime inserts are plain `INSERT`s) and the system role the rest, and
adds the `outbox_insert` policy `WITH CHECK (tenant_id = app.tenant_id())`.

## The relay

Every process that owns an outbox runs its relay; only the holder of the Redis lock
`outbox-relay:<name>` (`DistributedLockService`) publishes. Delivery is at least once, and
consumers dedupe on the envelope id.

- **Term.** One `DistributedLockService.using(lock, OUTBOX_LOCK_TTL_MS, …)`. The lock's
  auto-extension renews the TTL while the term runs. When the lock is held elsewhere or Redis is
  unreachable, the relay tries again after `OUTBOX_POLL_INTERVAL_MS` (±25 % jitter). When the
  lock's signal aborts, the relay stops before the next publish and the term ends.
- **Tick.** Inside `SystemContext.run('outbox.relay', …)`: `pollUnpublished(OUTBOX_BATCH_SIZE)`,
  then `publishStored` row by row in poll order, then `markPublished` for the rows the broker
  acknowledged. Each repository call is its own statement on the system pool, so no Postgres
  transaction is open while a publish is in flight. A full batch polls again at once; otherwise the
  relay waits `OUTBOX_POLL_INTERVAL_MS`.
- **Failure.** The first failed publish ends the batch. The earlier rows are marked; the failed row
  and the later ones stay and go out again. A row the producer always refuses blocks the outbox
  until an operator acts. A failed poll or mark is logged and counted by the system pool
  (`db_system_calls_total{outcome="error"}`), and its rows go out again. After any failed tick the
  wait doubles, from 2 × `OUTBOX_POLL_INTERVAL_MS` up to `OUTBOX_MAX_BACKOFF_MS`; a clean tick resets
  it.
- **Purge.** When a term starts, and then once per hour of leadership, it deletes the rows
  published more than `OUTBOX_RETENTION_HOURS` ago (`deletePublishedBefore`).
- **Lifecycle.** The relay starts on application bootstrap when `OUTBOX_RELAY_ENABLED` is true and
  `DATABASE_SYSTEM_URL` is set; without a system pool it logs one warning and stays off. It stops
  in `beforeApplicationShutdown`, before Redis, the pools and the Kafka client close, and waits at
  most `OUTBOX_LOCK_TTL_MS` for the in-flight publish.

```ts
@Module({
  imports: [
    OutboxModule.forFeature({
      feature: ORDERS_OUTBOX,
      writer: OrdersOutbox,
      systemRepository: OrdersOutboxSystemRepository,
    }),
  ],
})
export class OrdersModule {}
```

The root module provides `DatabaseModule`, `KafkaProducerModule` and `RedisModule`.

## Metrics

`OutboxRelay` exports five series through `@platform/observability`'s `getOrCreate*` helpers (the
process-wide registry `/metrics` serves), all labelled `outbox` with the feature name:

| Metric                                  | Type      | Labels                       | Meaning                                                                                                           |
| --------------------------------------- | --------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `outbox_backlog`                        | gauge     | `outbox`                     | Unpublished rows at the leader's last poll (`OutboxPoll.backlog`).                                                |
| `outbox_oldest_unpublished_age_seconds` | gauge     | `outbox`                     | Now minus the `created_at` of the oldest unpublished row at that poll; 0 when there is none.                      |
| `outbox_publish_latency_seconds`        | histogram | `outbox`, `topic`            | Publish acknowledgement time minus `created_at`, observed once per acknowledged row (a resend is observed again). |
| `outbox_published_total`                | counter   | `outbox`, `topic`, `outcome` | One per publish attempt: `ok` when the broker acknowledged, `error` for the failed row that ends a batch.         |
| `outbox_relay_leader`                   | gauge     | `outbox`                     | 1 while this process holds the relay lock; 0 once its relay started and while it follows, and after a term ends.  |

Only the leader sets the backlog and age. When a term ends (lock lost, shutdown, failure) the
leader gauge reads 0 and the backlog and age series of that outbox are removed, so a sum over
processes never adds a former leader's stale value. `OutboxMetrics` is exported for code that drives
a relay by hand.

## Alerts

`docker/prometheus/rules/outbox.rules.yml` alerts on these series (`scripts/prometheus-rules.spec.ts` pins them):
`OutboxBacklogStuck` (oldest unpublished age above 300 s for 5 m, page), `OutboxPublishErrors` (any `error` rate for 10 m,
ticket) and `OutboxNoLeader` (no `outbox_relay_leader == 1` for 5 m, page). The runbook is in
[OBSERVABILITY.md](../../docs/OBSERVABILITY.md#outbox-ledger-and-ai-alerts).

## Configuration

Namespace `outbox` in `@platform/config` (`OUTBOX_RELAY_ENABLED`, `OUTBOX_POLL_INTERVAL_MS`,
`OUTBOX_BATCH_SIZE`, `OUTBOX_LOCK_TTL_MS`, `OUTBOX_MAX_BACKOFF_MS`, `OUTBOX_RETENTION_HOURS`); see
[CONFIGURATION.md](../../docs/CONFIGURATION.md#outbox--transactional-outbox-relay).

## Testing

`@platform/outbox/testing`:

- `InMemoryOutbox(feature, { kafka?, txHost?, now? })`: the writer and the system repository over
  one array (`records`, `unpublished()`). `enqueue` keeps the real validation and tenant rules (and
  the transaction check when `txHost` is given); `pollUnpublished`, `markPublished`,
  `insertAsPlatform` and `deletePublishedBefore` behave as the SQL does and need `SystemContext`.
- `describeOutboxTable(table, schema)`: the shape spec of a hand-declared outbox table.

End to end: `apps/monolith/test/outbox.e2e-spec.ts` (request → row → tick → Kafka → consumer, a failing producer, a
redelivered webhook) and `apps/monolith/test/ledger.e2e-spec.ts` (webhook → outbox → relay → consumer → ledger →
reconciliation); the microservices topology in `apps/billing-service/test/app.e2e-spec.ts` and
`apps/gateway/test/app.e2e-spec.ts`.
