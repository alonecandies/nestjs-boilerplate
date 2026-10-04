import type { DrizzleDB } from '@app/database';
import { drizzle } from 'drizzle-orm/postgres-js';
import { vi } from 'vitest';

/** One result row: its VALUES must be in SELECT column order (drizzle reads rows positionally). */
export type FakeRow = Record<string, unknown>;
export type FakeQueryHandler = (sql: string, params: readonly unknown[]) => FakeRow[];

export interface ExecutedQuery {
  sql: string;
  params: readonly unknown[];
}

/**
 * The `DRIZZLE` provider for app e2e tests: a REAL drizzle instance (the repositories build
 * prepared statements in their constructors, and drizzle maps rows to the schema) over a fake
 * postgres.js `Sql` client — the network edge. Covers what the app touches: `unsafe(query, params)`
 * (+ `.values()`) for drizzle, the tagged template for `DatabaseHealthIndicator`'s `select 1`, and
 * `end()` for the pool shutdown hook.
 */
export function createFakePostgres<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  handler: FakeQueryHandler,
): { db: DrizzleDB<TSchema>; executed: ExecutedQuery[]; end: ReturnType<typeof vi.fn> } {
  const executed: ExecutedQuery[] = [];
  const run = (query: string, params: readonly unknown[]) => {
    const sql = query.replace(/\s+/g, ' ').trim();
    executed.push({ sql, params });
    const pending = Promise.resolve().then(() => handler(sql, params));
    return Object.assign(pending, {
      values: async (): Promise<unknown[][]> => (await pending).map((row) => Object.values(row)),
      cancel: (): void => undefined,
    });
  };
  const end = vi.fn(async () => undefined);
  const client = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => run(strings.join('?'), values),
    {
      unsafe: (query: string, params: unknown[] = []) => run(query, params),
      options: { parsers: {}, serializers: {} },
      end,
    },
  );
  const db: DrizzleDB<TSchema> = drizzle({ client: client as never, schema, casing: 'snake_case' });
  return { db, executed, end };
}
