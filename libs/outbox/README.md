# @platform/outbox

The transactional outbox. An integration event is written to `<schema>.outbox` in the transaction
that changes the state it reports, so the two commit or roll back together. A relay then publishes
the rows to Kafka, at least once. The package names no domain: each Postgres domain owns its outbox
table, migration, policy and a thin system repository.

## Public API

| Export                                              | Kind           | Purpose                                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OutboxWriter`                                      | abstract class | `constructor(feature, txHost, kafka)`. Each domain subclasses it once; the subclass is the DI token.                                                                                                                                                                      |
| `OutboxWriter#record(contract, payload, options?)`  | method         | A validated `OutboxRecord`, no SQL. Envelopes come from `KafkaProducer.createRecord`, so tenant, actor and correlation id default the same way. Works without a transaction or principal when `options.tenantId` is given, the platform tenant included.                  |
| `OutboxWriter#enqueue(contract, payload, options?)` | method         | `record()` plus one plain `INSERT` (no `RETURNING`, no `ON CONFLICT`) in the caller's open transaction; it never opens one. The row's tenant is the principal's. Returns the envelope. Nothing is sent to Kafka.                                                          |
| `OutboxError`                                       | error          | `code`: `OUTBOX_NO_TRANSACTION` (no open transaction), `OUTBOX_TENANT_REQUIRED` (no tenant), `OUTBOX_TENANT_MISMATCH` (`options.tenantId` is not the principal's), `OUTBOX_PLATFORM_TENANT` (a runtime row for the nil tenant). A programming error: it renders as a 500. |
| `OutboxTable`, `OutboxFeature`                      | types          | The drizzle table type every outbox table matches, and `{ name, table }` (`name` = the Postgres schema; it also names the relay lock and metric labels).                                                                                                                  |
| `OutboxRecord`, `OutboxRow`, `OutboxPoll`           | types          | A stored event (`id` = envelope id, `tenantId` = envelope tenant), a polled row (`createdAt`), and one poll with its backlog statistics.                                                                                                                                  |

`@platform/transport` adds the send side: `KafkaProducer#publishStored(topic, envelope, key)` sends
a stored envelope unchanged (generic envelope schema and `type === topic` checked, headers rebuilt
from the envelope, nothing read from CLS).

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
