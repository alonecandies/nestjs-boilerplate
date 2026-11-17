/*
 * The outbox test fixture: a table declared exactly the way a domain declares its `<schema>.outbox`
 * (schema `fx`), two event contracts in the neutral vocabulary, and a recording Drizzle handle
 * behind the real RLS transaction adapter.
 */
import { generateId } from '@platform/common';
import { defineEventContract } from '@platform/contracts';
import {
  buildRlsContextSql,
  DRIZZLE,
  type DrizzleDB,
  DrizzlePostgresTransactionalAdapter,
  type DrizzleTransactionalAdapter,
  type DrizzleTransactionHost,
  TransactionHost,
} from '@platform/database';
import { sql } from 'drizzle-orm';
import { index, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import type { OutboxFeature } from '../src/outbox.types.js';

const timestamptz = () => timestamp({ withTimezone: true, precision: 3, mode: 'date' });

export const fxPgSchema = pgSchema('fx');

/** What every domain schema file declares for its outbox (here in the fixture schema `fx`). */
export const fxOutbox = fxPgSchema.table(
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
    index('outbox_unpublished_idx').on(t.createdAt, t.id).where(sql`${t.publishedAt} IS NULL`),
    index('outbox_published_at_idx').on(t.publishedAt).where(sql`${t.publishedAt} IS NOT NULL`),
  ],
);

export const FX_OUTBOX: OutboxFeature = { name: 'fx', table: fxOutbox };

export interface OrderPlacedPayload {
  orderId: string;
  totalMinor: number;
}

/** Tenant-scoped: the envelope must carry a tenant. */
export const ORDER_PLACED_EVENT = defineEventContract<OrderPlacedPayload>(
  'orders.order-placed.v1',
  z.object({ orderId: z.uuid(), totalMinor: z.number().int().nonnegative() }),
  { tenantScoped: true },
);

/** Not tenant-scoped: the producer may leave the tenant out. */
export const CATALOG_UPDATED_EVENT = defineEventContract<{ sku: string }>(
  'catalog.item-updated.v1',
  z.object({ sku: z.string().min(1) }),
);

export const orderPlaced = (): OrderPlacedPayload => ({ orderId: generateId(), totalMinor: 2_500 });

export interface RecordedQuery {
  sql: string;
  params: unknown[];
}

/**
 * A real Drizzle handle (`casing: 'snake_case'`, like `DatabaseModule`) over a fake postgres.js
 * client. `queries` holds each statement drizzle built; `transcript` everything the client saw,
 * in order: `begin` / `commit` / `rollback`, the RLS context the adapter sends after BEGIN (a
 * parameterless `unsafe(sql).simple()`) and each statement.
 */
export function createRecordingDrizzle(): {
  db: DrizzleDB;
  queries: RecordedQuery[];
  transcript: string[];
} {
  const queries: RecordedQuery[] = [];
  const transcript: string[] = [];
  const pending = (rows: unknown[][]) =>
    Object.assign(Promise.resolve(rows), {
      values: () => Promise.resolve(rows),
      simple() {
        return this;
      },
    });
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe: (sqlText: string, params?: unknown[]) => {
      transcript.push(sqlText);
      if (params !== undefined) queries.push({ sql: sqlText, params });
      return pending([]);
    },
    begin: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      transcript.push('begin');
      try {
        const result = await work(client);
        transcript.push('commit');
        return result;
      } catch (error) {
        transcript.push('rollback');
        throw error;
      }
    },
  };
  const db = drizzle({ client: client as never, casing: 'snake_case' }) as unknown as DrizzleDB;
  return { db, queries, transcript };
}

/** The `TransactionHost` the apps get: BEGIN sends the CLS principal's RLS context, or refuses. */
export function createRlsTransactionHost(db: DrizzleDB): DrizzleTransactionHost {
  const adapter = new DrizzlePostgresTransactionalAdapter({ drizzleInstanceToken: DRIZZLE });
  return new TransactionHost<DrizzleTransactionalAdapter>({
    ...adapter.optionsFactory(db),
    connectionName: undefined,
    enableTransactionProxy: false,
    defaultTxOptions: {},
    extraProviderTokens: [],
  });
}

/** What the adapter sends after BEGIN for this user and tenant. */
export const rlsContextStatement = (userId: string, tenantId: string | null): string =>
  buildRlsContextSql({ userId, tenantId });
