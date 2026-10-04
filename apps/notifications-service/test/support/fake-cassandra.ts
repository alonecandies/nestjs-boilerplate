import type { CassandraClient } from '@app/cassandra';
import type cassandra from 'cassandra-driver';
import { vi } from 'vitest';

export interface ExecutedCql {
  cql: string;
  params: readonly unknown[];
  options: cassandra.QueryOptions;
}

/** What one statement "returns": rows (column → cell value), the next page state, LWT outcome. */
export interface FakeCqlResult {
  rows?: Record<string, unknown>[];
  pageState?: string | null;
  applied?: boolean;
}

export type FakeCqlHandler = (cql: string, params: readonly unknown[]) => FakeCqlResult;

/** A driver `Row`: cells readable with `row.get(column)` (how the repositories read them). */
function toRow(cells: Record<string, unknown>): cassandra.types.Row {
  return { ...cells, get: (column: string): unknown => cells[column] } as cassandra.types.Row;
}

/**
 * The `CASSANDRA_CLIENT` provider for app e2e tests — the network edge of the Cassandra
 * repositories and health indicator: `execute()` answered by `handler` (shaped like a driver
 * `ResultSet`) and `shutdown()` for the module's shutdown hook. Every call is recorded.
 */
export function createFakeCassandra(handler: FakeCqlHandler): {
  client: CassandraClient;
  executed: ExecutedCql[];
  shutdown: ReturnType<typeof vi.fn>;
} {
  const executed: ExecutedCql[] = [];
  const shutdown = vi.fn(async () => undefined);
  const execute = vi.fn(
    async (cql: string, params: readonly unknown[] = [], options: cassandra.QueryOptions = {}) => {
      executed.push({ cql, params, options });
      const result = handler(cql, params);
      const rows = (result.rows ?? []).map(toRow);
      return {
        rows,
        rowLength: rows.length,
        pageState: result.pageState ?? null,
        first: () => rows[0] ?? null,
        wasApplied: () => result.applied ?? true,
      };
    },
  );
  const client = { execute, shutdown } as unknown as CassandraClient;
  return { client, executed, shutdown };
}
