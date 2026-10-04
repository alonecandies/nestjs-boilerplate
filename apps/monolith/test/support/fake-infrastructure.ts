import type { CassandraClient } from '@app/cassandra';
import type { DrizzleDB, DrizzleSchema } from '@app/database';
import { createL1Store } from '@app/redis';
import { createCache } from 'cache-manager';
import { drizzle } from 'drizzle-orm/postgres-js';

/*
 * Fakes for the network edges of the monolith. Each one replaces exactly the provider that would
 * open a connection (DRIZZLE, CASSANDRA_CLIENT, the BullMQ queue, the L2 cache) and keeps the
 * surface the real code touches, so everything above it — repositories, health indicators,
 * shutdown hooks — runs unmodified.
 */

export interface RecordedQuery {
  sql: string;
  params: unknown[];
}

export type FakeRows = Record<string, unknown>[];

/**
 * A REAL drizzle instance over a fake postgres.js `Sql` client. The Drizzle repositories prepare
 * their statements in their constructors, so DRIZZLE cannot be a bare stub. The client offers
 * what drizzle's postgres-js session uses (`unsafe()` + `.values()`, the parser/serializer maps,
 * `begin()`), the tagged-template `select 1` of the readiness probe (with `cancel()`) and the
 * `end()` of DatabaseModule's shutdown hook. Every statement is recorded and answered by
 * `respond` (default: no rows).
 */
export function createFakePostgres(
  schema: DrizzleSchema,
  respond: (sql: string, params: unknown[]) => FakeRows = () => [],
) {
  const queries: RecordedQuery[] = [];
  const state = { ended: false };

  const run = (sql: string, params: unknown[]) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    queries.push({ sql: normalized, params });
    const pending = Promise.resolve().then(() => respond(normalized, params));
    return Object.assign(pending, {
      values: async (): Promise<unknown[][]> => (await pending).map((row) => Object.values(row)),
      cancel: (): void => undefined,
    });
  };

  const client = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => run(strings.join('$?'), values),
    {
      unsafe: (sql: string, params: unknown[] = []) => run(sql, params),
      begin: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(client),
      end: async (): Promise<void> => {
        state.ended = true;
      },
      options: { parsers: {}, serializers: {} },
    },
  );

  // The fake only has the slice of `Sql` that drizzle touches.
  const db: DrizzleDB = drizzle({ client: client as never, schema, casing: 'snake_case' });
  return { db, queries, state };
}

/** `CASSANDRA_CLIENT` stand-in: empty result sets, a `system.local` row for the health probe. */
export function createFakeCassandra() {
  const executed: { cql: string; params: unknown }[] = [];
  const state = { shutdown: false };
  const client = {
    execute: async (cql: string, params?: unknown) => {
      executed.push({ cql, params });
      const rows = cql.includes('system.local') ? [{ release_version: '5.0.6' }] : [];
      return {
        rows,
        rowLength: rows.length,
        pageState: null,
        first: () => rows[0] ?? null,
        wasApplied: () => true,
      };
    },
    shutdown: async (): Promise<void> => {
      state.shutdown = true;
    },
  };
  return { client: client as unknown as CassandraClient, executed, state };
}

/** The BullMQ `mail` queue: records jobs instead of writing them to Redis. */
export function createFakeQueue() {
  const jobs: { name: string; data: unknown; opts: unknown }[] = [];
  return {
    jobs,
    add: async (name: string, data: unknown, opts?: unknown) => {
      jobs.push({ name, data, opts });
      return { id: `job-${jobs.length}`, name, data };
    },
    close: async (): Promise<void> => undefined,
    // MailService attaches its connection-error logger at init.
    on: (): void => undefined,
  };
}

/**
 * `CACHE_MANAGER` with the real L1 tier only. @keyv/redis (L2) runs its own node-redis
 * connection, which InMemoryRedis cannot stand in for; `AppCacheService` itself stays real.
 */
export function createL1OnlyCache() {
  return createCache({ stores: [createL1Store({ ttlMs: 5_000, maxItems: 1_000 })] });
}
