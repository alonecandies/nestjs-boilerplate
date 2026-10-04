import type cassandra from 'cassandra-driver';

/** The driver client injected via `@InjectCassandra()` (already connected, keyspace-bound). */
export type CassandraClient = cassandra.Client;

/** Positional (`?`) or named (`:name`) bind parameters. */
export type CqlParams = unknown[] | Record<string, unknown>;

/** A folder of `NNN_name.cql` migration files (e.g. `join(import.meta.dirname, 'migrations')`). */
export interface CassandraMigrationSource {
  dir: string;
}

/**
 * Keyspace replication used by `CREATE KEYSPACE IF NOT EXISTS` at boot. `SimpleStrategy` is fine
 * for a single DC; production multi-DC clusters need `NetworkTopologyStrategy` with DC names
 * exactly as `nodetool status` prints them. Changing it later needs a manual `ALTER KEYSPACE`
 * + repair — the boot step never alters an existing keyspace.
 */
export type CassandraReplication =
  | { class: 'SimpleStrategy'; replicationFactor: number }
  | { class: 'NetworkTopologyStrategy'; dataCenters: Readonly<Record<string, number>> };

export interface CassandraModuleOptions {
  /** CQL migration folders, applied in order (files sorted by numeric prefix within a folder). */
  migrations?: readonly CassandraMigrationSource[];
  /** Overrides `CASSANDRA_RUN_MIGRATIONS` (keyspace bootstrap + CQL migrations at boot). */
  runMigrations?: boolean;
  /** Overrides the default `SimpleStrategy` with `CASSANDRA_REPLICATION_FACTOR`. */
  replication?: CassandraReplication;
  /** Max wait for another replica that is applying a migration. Default 2 min. */
  migrationLockTimeoutMs?: number;
}
