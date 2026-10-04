import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preferPreparedStatements } from './prepared-statements.js';

/**
 * The postgres.js surface the helper touches. `begin`/`savepoint` hand their callback a fresh
 * scoped client (like postgres.js); each scoped client's ORIGINAL `unsafe` mock is kept in
 * `scopedUnsafe` so the test can see what the wrapper forwarded.
 */
function fakeClient() {
  const scopedUnsafe: ReturnType<typeof vi.fn>[] = [];
  const openScope = async (...args: unknown[]): Promise<unknown> => {
    const fn = args.at(-1) as (tx: TransactionSql) => unknown;
    const unsafe = vi.fn();
    scopedUnsafe.push(unsafe);
    return fn({ unsafe, savepoint: vi.fn(openScope) } as unknown as TransactionSql);
  };
  const client = { unsafe: vi.fn(), begin: vi.fn(openScope) };
  return { client, scopedUnsafe, sql: client as unknown as Sql };
}

describe('preferPreparedStatements', () => {
  let real: Sql | undefined;
  afterEach(async () => {
    await real?.end({ timeout: 0 });
    real = undefined;
  });

  it('real postgres.js: drizzle-style unsafe(text, params) now asks for a prepared statement', () => {
    // Lazy client: no connection is opened until a query is awaited.
    real = postgres('postgres://u:p@127.0.0.1:1/db', { prepare: true });
    /** postgres.js' Query keeps its effective options (not in the public typings). */
    const optionsOf = (query: unknown): unknown => (query as { options: unknown }).options;
    expect(optionsOf(real.unsafe('select $1', [1]))).toMatchObject({ prepare: false });

    const wrapped = preferPreparedStatements(real);
    expect(optionsOf(wrapped.unsafe('select $1', [1]))).toMatchObject({ prepare: true });
    // An explicit choice still wins; the original client is untouched.
    expect(optionsOf(wrapped.unsafe('select $1', [1], { prepare: false }))).toMatchObject({
      prepare: false,
    });
    expect(optionsOf(real.unsafe('select $1', [1]))).toMatchObject({ prepare: false });
    expect(wrapped.options).toBe(real.options);
  });

  it('defaults unsafe() to prepare: true, keeping params and other options', () => {
    const { client, sql: raw } = fakeClient();
    const original = client.unsafe;
    const sql = preferPreparedStatements(raw);

    void sql.unsafe('select $1', [1]);
    void sql.unsafe('select 1');
    void sql.unsafe('select $1', [1], { prepare: false });
    expect(original.mock.calls).toEqual([
      ['select $1', [1], { prepare: true }],
      ['select 1', [], { prepare: true }],
      ['select $1', [1], { prepare: false }],
    ]);
  });

  it('transaction and savepoint clients get the same default (begin(fn) and begin(options, fn))', async () => {
    const { client, scopedUnsafe, sql: raw } = fakeClient();
    const { begin, unsafe } = client;
    const sql = preferPreparedStatements(raw);

    await sql.begin(async (tx) => {
      void tx.unsafe('update t set x = $1', [1]);
      await tx.savepoint('nested', async (sp) => {
        void sp.unsafe('update t set x = $1', [2]);
      });
    });
    await sql.begin('isolation level serializable', async (tx) => {
      void tx.unsafe('update t set x = $1', [3]);
    });

    expect(begin.mock.calls[1]?.[0]).toBe('isolation level serializable');
    expect(scopedUnsafe.map((unsafe) => unsafe.mock.calls)).toEqual([
      [['update t set x = $1', [1], { prepare: true }]],
      [['update t set x = $1', [2], { prepare: true }]],
      [['update t set x = $1', [3], { prepare: true }]],
    ]);
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('tolerates a client without begin/savepoint', () => {
    const unsafe = vi.fn();
    const sql = preferPreparedStatements({ unsafe } as unknown as Sql);
    void sql.unsafe('select 1', []);
    expect(sql.begin).toBeUndefined();
    expect(unsafe).toHaveBeenCalledWith('select 1', [], { prepare: true });
  });
});
