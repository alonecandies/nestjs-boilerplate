import { drizzle } from 'drizzle-orm/postgres-js';
import { vi } from 'vitest';
import {
  type IdentitySchema,
  identitySchema,
} from '../src/infrastructure/persistence/identity.schema.js';

/** Rows (objects in SELECT column order) for one statement; `count` = affected rows. */
export type FakeResult = Record<string, unknown>[] & { count?: number };
export type FakeQueryHandler = (
  query: string,
  params: unknown[],
) => FakeResult | Promise<FakeResult>;

export interface ExecutedQuery {
  sql: string;
  params: unknown[];
}

/**
 * The slice of a postgres.js `Sql` client drizzle's postgres-js session uses: `unsafe(query,
 * params)` (awaitable, plus `.values()` for positional rows) and the parser/serializer maps the
 * driver patches. Lets repository tests run drizzle's real query building and result mapping
 * without a database.
 */
export function createFakePostgres(handler: FakeQueryHandler = () => []) {
  const executed: ExecutedQuery[] = [];
  const unsafe = vi.fn((query: string, params: unknown[] = []) => {
    const sql = query.replace(/\s+/g, ' ').trim();
    executed.push({ sql, params });
    const pending = Promise.resolve().then(() => handler(sql, params));
    return Object.assign(pending, {
      values: async (): Promise<unknown[][]> => (await pending).map((row) => Object.values(row)),
    });
  });
  const client = { unsafe, options: { parsers: {}, serializers: {} } };
  const db = drizzle({ client: client as never, schema: identitySchema, casing: 'snake_case' });
  return { db, executed, unsafe };
}

export type FakeDb = ReturnType<typeof createFakePostgres>['db'];
export type { IdentitySchema };

/** `count` on a result (postgres.js RowList). */
export const affected = (count: number): FakeResult => Object.assign([], { count });
