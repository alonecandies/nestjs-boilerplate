/**
 * @internal The postgres.js transaction client under a drizzle transaction, for the RLS statements
 * (the context on BEGIN, elevation). They go out with `unsafe(sql).simple()`: one simple-protocol
 * round trip, which `preferPreparedStatements` cannot force onto the prepared path. Not exported
 * from the package index.
 */

/** The slice of the postgres.js transaction client the RLS statements need. */
export interface SimpleQueryClient {
  unsafe(query: string): { simple(): PromiseLike<unknown> };
}

/**
 * drizzle's postgres-js transaction keeps its postgres.js transaction client on
 * `tx.session.client` (the reserved connection, wrapped by `preferPreparedStatements`); a
 * savepoint's client is the same connection.
 */
export function transactionClientOf(tx: unknown): SimpleQueryClient {
  const client: unknown = (tx as { session?: { client?: unknown } } | undefined)?.session?.client;
  if (typeof (client as Partial<SimpleQueryClient> | undefined)?.unsafe !== 'function') {
    throw new Error('RLS context: the drizzle transaction exposes no postgres.js client');
  }
  return client as SimpleQueryClient;
}
