import type { Sql, TransactionSql } from 'postgres';

/** A pool, transaction or savepoint client: everything drizzle's postgres-js session calls. */
type AnySql = Sql | TransactionSql;
type Unsafe = AnySql['unsafe'];
type ScopedCallback = (tx: TransactionSql) => unknown;
type ScopeOpener = (...args: [ScopedCallback] | [string, ScopedCallback]) => Promise<unknown>;

/**
 * Makes drizzle's queries use server-side prepared statements when the client has `prepare: true`.
 *
 * drizzle-orm's postgres-js driver sends EVERY query (including `.prepare('name')`d ones) through
 * `client.unsafe(text, params)` without options, and postgres.js defaults `unsafe()` to
 * `prepare: false`: each call was an unnamed Parse/Bind/Execute, parsed and planned again. This
 * switches that default to `prepare: true` on the pool client and on the transaction / savepoint
 * clients it hands out (`begin`, `savepoint`). postgres.js only prepares when the CLIENT option is
 * true as well, so `DATABASE_PREPARE=false` (PgBouncer transaction mode, RDS Proxy) still sends
 * unnamed statements. An explicit `prepare` in the call's options always wins. Returns a wrapper;
 * the client passed in is left untouched (postgres.js' own internals keep their defaults).
 *
 * Statements are cached per connection, keyed by SQL text, without eviction: keep query text
 * bounded (one array parameter — `= any($1::uuid[])` — rather than `IN ($1…$n)` lists).
 * `DATABASE_MAX_LIFETIME_SEC` recycles connections, and their caches, anyway.
 */
export function preferPreparedStatements<T extends AnySql>(client: T): T {
  const unsafe: Unsafe = client.unsafe.bind(client);
  const prepared = (...args: Parameters<Unsafe>): ReturnType<Unsafe> => {
    const [query, parameters, options] = args;
    return unsafe(query, parameters ?? [], { prepare: true, ...options });
  };
  const begin = scopeOpener(client, 'begin');
  const savepoint = scopeOpener(client, 'savepoint');
  // A Proxy (the client itself is not modified): calls as a tagged template, `options` (drizzle
  // patches its parsers), `end()`… all reach the real client.
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'unsafe') return prepared;
      if (property === 'begin' && begin) return begin;
      if (property === 'savepoint' && savepoint) return savepoint;
      return Reflect.get(target, property, receiver);
    },
  });
}

/** `begin(fn)` / `begin(options, fn)` (and `savepoint`): hand `fn` a client with the same default. */
function scopeOpener(client: AnySql, method: 'begin' | 'savepoint'): ScopeOpener | undefined {
  const original: unknown = Reflect.get(client, method);
  if (typeof original !== 'function') return undefined;
  const open = original.bind(client) as ScopeOpener;
  return (...args) => {
    if (args.length === 1) {
      const [fn] = args;
      return open((tx) => fn(preferPreparedStatements(tx)));
    }
    const [name, fn] = args;
    return open(name, (tx) => fn(preferPreparedStatements(tx)));
  };
}
