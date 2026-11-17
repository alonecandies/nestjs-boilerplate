/*
 * The outbox test fixture: a table declared exactly the way a domain declares its `<schema>.outbox`
 * (schema `fx`), the SQL every outbox migration ends up with (for the int specs), a system
 * repository subclassed the way a domain does it, two event contracts in the neutral vocabulary,
 * and a recording Drizzle handle behind the real RLS transaction adapter.
 */
import { Injectable } from '@nestjs/common';
import { generateId } from '@platform/common';
import { defineEventContract } from '@platform/contracts';
import {
  buildRlsContextSql,
  DRIZZLE,
  type DrizzleDB,
  DrizzlePostgresTransactionalAdapter,
  type DrizzleTransactionalAdapter,
  type DrizzleTransactionHost,
  InjectSystemDatabase,
  SystemDatabase,
  TransactionHost,
} from '@platform/database';
import { sql } from 'drizzle-orm';
import { index, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import { OutboxSystemRepository } from '../src/outbox.system-repository.js';
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

/** The Drizzle schema of the fixture (what a domain passes to `DatabaseModule`). */
export const fxSchema = { fxOutbox };
export type FxSchema = typeof fxSchema;

/** How a domain subclasses the system repository: its own schema-typed `SystemDatabase`. */
@Injectable()
export class FxOutboxSystemRepository extends OutboxSystemRepository {
  constructor(@InjectSystemDatabase() system: SystemDatabase<FxSchema>) {
    super(FX_OUTBOX, system);
  }
}

/**
 * The "Outbox table" SQL of the plan for schema `fx`, in migration order (CREATE → distribution →
 * indexes → RLS → grants → policy), one statement each: with local execution off, Citus creates the
 * shards over new connections, so each statement must commit before the next. Run as `app_owner`
 * after the platform migrations; the two `USAGE` grants stand in for the domain's schema grants.
 */
export const FX_OUTBOX_DDL: readonly string[] = [
  'CREATE SCHEMA "fx"',
  'GRANT USAGE ON SCHEMA "fx" TO app_runtime',
  'GRANT USAGE ON SCHEMA "fx" TO app_system',
  `CREATE TABLE "fx"."outbox" ("tenant_id" uuid NOT NULL, "id" uuid NOT NULL, "topic" text NOT NULL, "key" text,
  "envelope" jsonb NOT NULL, "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
  "published_at" timestamp (3) with time zone, CONSTRAINT "outbox_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"))`,
  "SELECT app.distribute_by_tenant('fx.outbox')",
  'CREATE INDEX "outbox_unpublished_idx" ON "fx"."outbox" ("created_at","id") WHERE "published_at" IS NULL',
  'CREATE INDEX "outbox_published_at_idx" ON "fx"."outbox" ("published_at") WHERE "published_at" IS NOT NULL',
  'ALTER TABLE "fx"."outbox" ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE "fx"."outbox" FORCE ROW LEVEL SECURITY',
  'GRANT INSERT ON "fx"."outbox" TO app_runtime',
  'GRANT SELECT, INSERT, UPDATE, DELETE ON "fx"."outbox" TO app_system',
  'CREATE POLICY "outbox_insert" ON "fx"."outbox" FOR INSERT TO app_runtime WITH CHECK (tenant_id = app.tenant_id())',
];

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

/** A canned answer of the recording client: array-mode rows (what `.values()` yields) and a count. */
export interface RecordedAnswer {
  readonly rows?: readonly unknown[][];
  readonly count?: number;
}

/**
 * A real Drizzle handle (`casing: 'snake_case'`, like `DatabaseModule`) over a fake postgres.js
 * client. `queries` holds each statement drizzle built; `transcript` everything the client saw,
 * in order: `begin` / `commit` / `rollback`, the RLS context the adapter sends after BEGIN (a
 * parameterless `unsafe(sql).simple()`) and each statement. `respond` answers a statement (default:
 * no rows, count 0); a selected column comes back by position, as postgres.js `.values()` gives it.
 */
export function createRecordingDrizzle(
  respond: (query: RecordedQuery) => RecordedAnswer | undefined = () => undefined,
): {
  db: DrizzleDB;
  queries: RecordedQuery[];
  transcript: string[];
} {
  const queries: RecordedQuery[] = [];
  const transcript: string[] = [];
  const pending = (answer: RecordedAnswer | undefined) => {
    const rows = [...(answer?.rows ?? [])];
    const result = Object.assign(rows, { count: answer?.count ?? rows.length });
    return Object.assign(Promise.resolve(result), {
      values: () => Promise.resolve(result),
      simple() {
        return this;
      },
    });
  };
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe: (sqlText: string, params?: unknown[]) => {
      transcript.push(sqlText);
      if (params === undefined) return pending(undefined);
      const query = { sql: sqlText, params };
      queries.push(query);
      return pending(respond(query));
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
