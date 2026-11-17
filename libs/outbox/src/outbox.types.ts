import type { EventEnvelope } from '@platform/contracts';
import { jsonb, type PgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const timestamptz = () => timestamp({ withTimezone: true, precision: 3, mode: 'date' });

/**
 * The column set every outbox table declares, column for column (`casing: 'snake_case'`). It is a
 * TYPE template, never called: each domain declares its own `<schema>.outbox` by hand in its schema
 * file (drizzle-kit loads schema files without workspace resolution), with this exact body plus the
 * primary key `outbox_tenant_id_id_pk (tenant_id, id)` and the two partial indexes
 * `outbox_unpublished_idx (created_at, id) WHERE published_at IS NULL` and
 * `outbox_published_at_idx (published_at) WHERE published_at IS NOT NULL`, which
 * `describeOutboxTable` (`@platform/outbox/testing`) pins in the domain's schema spec.
 */
function outboxTableTemplate(schema: PgSchema<string>) {
  return schema.table('outbox', {
    tenantId: uuid().notNull(),
    id: uuid().notNull(),
    topic: text().notNull(),
    key: text(),
    envelope: jsonb().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    publishedAt: timestamptz(),
  });
}

/** A drizzle pg table named `outbox` with exactly the columns of the outbox table (see above). */
export type OutboxTable = ReturnType<typeof outboxTableTemplate>;

/** One outbox: `name` is the Postgres schema that holds it; it also names the relay lock and labels. */
export interface OutboxFeature {
  readonly name: string;
  readonly table: OutboxTable;
}

/** One validated event as the outbox stores it: `id` = `envelope.id`, `tenantId` = `envelope.tenantId`. */
export interface OutboxRecord {
  readonly tenantId: string;
  readonly id: string;
  readonly topic: string;
  readonly key: string | null;
  readonly envelope: EventEnvelope<unknown>;
}

/** A stored, not yet published record as the relay polls it. */
export interface OutboxRow extends OutboxRecord {
  readonly createdAt: Date;
}

/** One poll: the oldest unpublished rows, plus the backlog statistics of all unpublished rows. */
export interface OutboxPoll {
  readonly rows: readonly OutboxRow[];
  readonly backlog: number;
  readonly oldestCreatedAt: Date | null;
}
