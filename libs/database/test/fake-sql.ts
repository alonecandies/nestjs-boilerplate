import { type Mock, vi } from 'vitest';

/** Resolves a query's rows. `query` is normalized SQL text: template params rendered as `$`. */
export type FakeSqlHandler = (query: string, values: unknown[]) => unknown[] | Promise<unknown[]>;

/** A pending query: awaitable, cancellable, and (for `unsafe`) with drizzle's `.values()` mode. */
export type FakeQuery = Promise<unknown[]> & {
  cancel: () => void;
  values: () => Promise<unknown[][]>;
};

export interface FakeSql {
  (strings: TemplateStringsArray | string, ...values: unknown[]): unknown;
  /** drizzle's postgres-js session runs every built query through `unsafe(sql, params)`. */
  unsafe: Mock<(query: string, params?: unknown[]) => FakeQuery>;
  /** postgres.js `sql.begin(fn)` — records `begin` / `commit` / `rollback` around `fn`. */
  begin: Mock<(fn: (tx: FakeSql) => Promise<unknown>) => Promise<unknown>>;
  end: Mock<(options?: { timeout?: number }) => Promise<void>>;
  /** What drizzle's postgres-js driver mutates on construction. */
  options: { parsers: Record<string, unknown>; serializers: Record<string, unknown> };
  /** Every statement in execution order (shared with transaction children). */
  queries: string[];
  cancels: Mock<() => void>;
}

const normalize = (query: string): string => query.replace(/\s+/g, ' ').trim();

/**
 * Minimal stand-in for a postgres.js `Sql` pool — enough for module wiring, `@Transactional()`,
 * health and migration-lock tests without a database: tagged templates and `unsafe()` resolve
 * through `handler`, `sql('ident')` returns an identifier marker, `begin()` hands `fn` a child
 * fake that shares the query log, and `end()` is a spy.
 */
export function createFakeSql(
  handler: FakeSqlHandler = () => [{ '?column?': 1 }],
  shared: { queries: string[]; cancels: Mock<() => void> } = {
    queries: [],
    cancels: vi.fn<() => void>(),
  },
): FakeSql {
  const { queries, cancels } = shared;
  const run = (query: string, values: unknown[]): FakeQuery => {
    queries.push(query);
    const pending = Promise.resolve().then(() => handler(query, values));
    return Object.assign(pending, {
      cancel: cancels,
      values: async (): Promise<unknown[][]> =>
        (await pending).map((row) => Object.values(row as Record<string, unknown>)),
    });
  };
  const sql = (strings: TemplateStringsArray | string, ...values: unknown[]): unknown => {
    if (typeof strings === 'string') return { identifier: strings };
    return run(normalize(strings.join('$')), values);
  };
  const fake: FakeSql = Object.assign(sql, {
    unsafe: vi.fn((query: string, params: unknown[] = []) => run(normalize(query), params)),
    begin: vi.fn(async (fn: (tx: FakeSql) => Promise<unknown>) => {
      queries.push('begin');
      try {
        const result = await fn(createFakeSql(handler, shared));
        queries.push('commit');
        return result;
      } catch (error) {
        queries.push('rollback');
        throw error;
      }
    }),
    end: vi.fn(async (_options?: { timeout?: number }) => undefined),
    options: { parsers: {}, serializers: {} },
    queries,
    cancels,
  });
  return fake;
}
