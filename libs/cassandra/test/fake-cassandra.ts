import type cassandra from 'cassandra-driver';
import { type Mock, vi } from 'vitest';
import type { CassandraClient } from '../src/cassandra.types.js';

/** One `client.execute()` call as the fake saw it. */
export interface ExecutedQuery {
  query: string;
  params: unknown;
  options: cassandra.QueryOptions | undefined;
}

export interface FakeResult {
  rows?: Record<string, unknown>[];
  pageState?: string | null;
  /** LWT outcome (`[applied]`). Default `true`. */
  applied?: boolean;
}

export type FakeCqlHandler = (
  query: string,
  params: unknown,
  options: cassandra.QueryOptions | undefined,
) => FakeResult | Promise<FakeResult>;

/** A driver `Row`: the column values as own properties plus `get(name)` (all our code uses). */
export function fakeRow(values: Record<string, unknown>): cassandra.types.Row {
  const row = { ...values, get: (column: string | number): unknown => values[String(column)] };
  return row as unknown as cassandra.types.Row;
}

/** The subset of `ResultSet` our code reads. */
export function fakeResultSet(result: FakeResult = {}): cassandra.types.ResultSet {
  const rows = (result.rows ?? []).map(fakeRow);
  return {
    rows,
    rowLength: rows.length,
    pageState: result.pageState ?? null,
    wasApplied: () => result.applied ?? true,
    first: () => rows[0] ?? null,
  } as unknown as cassandra.types.ResultSet;
}

export interface FakeCassandraClient {
  client: CassandraClient;
  execute: Mock<
    (
      query: string,
      params?: unknown,
      options?: cassandra.QueryOptions,
    ) => Promise<cassandra.types.ResultSet>
  >;
  executed: ExecutedQuery[];
}

/** `CassandraClient` stand-in whose `execute()` resolves through `handler`. */
export function createFakeCassandraClient(
  handler: FakeCqlHandler = () => ({}),
): FakeCassandraClient {
  const executed: ExecutedQuery[] = [];
  const execute = vi.fn(
    async (query: string, params?: unknown, options?: cassandra.QueryOptions) => {
      executed.push({ query, params, options });
      return fakeResultSet(await handler(query, params, options));
    },
  );
  const client = { execute, shutdown: vi.fn(async () => undefined) } as unknown as CassandraClient;
  return { client, execute, executed };
}
