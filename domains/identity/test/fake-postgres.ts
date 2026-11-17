import { createPrincipal, runWithPrincipal } from '@platform/common';
import {
  DrizzlePostgresTransactionalAdapter,
  type DrizzleTransactionalAdapter,
  TransactionHost,
} from '@platform/database';
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

/** The RLS context statement the transactional adapter sends after BEGIN (`SET LOCAL app.…`). */
const RLS_CONTEXT = /^SET LOCAL app\./;

/**
 * The slice of a postgres.js `Sql` client drizzle's postgres-js session uses: `unsafe(query,
 * params)` (awaitable, plus `.values()` for positional rows), `begin(fn)` for a transaction (the
 * child is the same fake) and the parser/serializer maps the driver patches. Lets repository tests
 * run drizzle's real query building and result mapping without a database.
 *
 * `executed` holds the data statements only; `transactions` logs `begin` / the RLS context
 * statement / `commit` or `rollback`, in order (the context never reaches `handler`).
 */
export function createFakePostgres(handler: FakeQueryHandler = () => []) {
  const executed: ExecutedQuery[] = [];
  const transactions: string[] = [];
  const unsafe = vi.fn((query: string, params: unknown[] = []) => {
    const sql = query.replace(/\s+/g, ' ').trim();
    const context = RLS_CONTEXT.test(sql);
    if (context) transactions.push(sql);
    else executed.push({ sql, params });
    const pending = Promise.resolve().then(() => (context ? [] : handler(sql, params)));
    return Object.assign(pending, {
      values: async (): Promise<unknown[][]> => (await pending).map((row) => Object.values(row)),
      // postgres.js simple protocol: the RLS context statement on BEGIN (`unsafe(sql).simple()`).
      simple() {
        return this;
      },
    });
  });
  const client: Record<string, unknown> = { unsafe, options: { parsers: {}, serializers: {} } };
  client['begin'] = async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    transactions.push('begin');
    try {
      const result = await fn(client);
      transactions.push('commit');
      return result;
    } catch (error) {
      transactions.push('rollback');
      throw error;
    }
  };
  const db = drizzle({ client: client as never, schema: identitySchema, casing: 'snake_case' });
  return { db, executed, transactions, unsafe };
}

/**
 * A real `TransactionHost` over `DrizzlePostgresTransactionalAdapter` and a fake `db` (what
 * `ClsPluginTransactional` provides at runtime): `inUnitOfWork` then opens a transaction whose BEGIN
 * carries the CLS principal's context, as in production. Call the repository under
 * `runWithPrincipal`.
 */
export function fakeTransactionHost(
  db: FakeDb,
): TransactionHost<DrizzleTransactionalAdapter<IdentitySchema>> {
  const adapter = new DrizzlePostgresTransactionalAdapter({ drizzleInstanceToken: 'DB' });
  return new TransactionHost({
    ...adapter.optionsFactory(db),
    connectionName: undefined,
    enableTransactionProxy: false,
    defaultTxOptions: {},
  } as never);
}

export type FakeDb = ReturnType<typeof createFakePostgres>['db'];
export type { IdentitySchema };

/** `count` on a result (postgres.js RowList). */
export const affected = (count: number): FakeResult => Object.assign([], { count });

/** The principal repository unit specs run as (the context the fake transaction records). */
export const SPEC_PRINCIPAL = createPrincipal({
  userId: '0197d000-0000-7000-8000-0000000000a1',
  tenantId: '0197d000-0000-7000-8000-0000000000a0',
  roles: ['member'],
});

/** The context statement the adapter sends for `SPEC_PRINCIPAL`. */
export const SPEC_CONTEXT =
  "SET LOCAL app.user_id = '0197d000-0000-7000-8000-0000000000a1'; " +
  "SET LOCAL app.tenant_id = '0197d000-0000-7000-8000-0000000000a0'; SET LOCAL app.elevated = 'off'";

/** `repository` with every method called under `runWithPrincipal(principal, …)`. */
export function asPrincipal<T extends object>(repository: T, principal = SPEC_PRINCIPAL): T {
  return new Proxy(repository, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        runWithPrincipal(principal, () =>
          (value as (...a: unknown[]) => unknown).apply(target, args),
        );
    },
  });
}
