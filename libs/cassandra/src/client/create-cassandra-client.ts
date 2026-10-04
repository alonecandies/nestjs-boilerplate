import { retry } from '@app/common';
import type { AppConfig, CassandraConfig } from '@app/config';
import { Logger } from '@nestjs/common';
import cassandra from 'cassandra-driver';
import { get, includes, noop } from 'lodash-es';
import type {
  CassandraClient,
  CassandraModuleOptions,
  CassandraReplication,
} from '../cassandra.types.js';
import { CqlMigrator } from '../migrations/cql-migrator.js';
import { buildClientOptions, createKeyspaceCql } from './client-options.js';

const { Client } = cassandra;

const CONNECT_RETRIES = 5;

/**
 * Cassandra 4+/5 warns on every PREPARE of an unqualified statement from a keyspace-bound client
 * (GOTCHA 17). Binding the client to the keyspace is a deliberate choice here (repositories may
 * use unqualified table names), so that one warning is demoted to debug.
 */
const USE_KEYSPACE_WARNING = /USE <keyspace>|anti-pattern/i;

/** The driver's own log stream → Nest Logger (pino). `info`/`verbose` are too chatty to keep. */
function attachDriverLogger(client: CassandraClient, logger: Logger): void {
  client.on('log', (level: string, className: string, message: string) => {
    if (level === 'error') logger.error(`${className}: ${message}`);
    else if (level === 'warning') {
      if (USE_KEYSPACE_WARNING.test(message)) logger.debug(`${className}: ${message}`);
      else logger.warn(`${className}: ${message}`);
    }
  });
}

/** Errors worth a reconnect attempt at boot (nodes still starting, DNS not ready…). */
function isTransientConnectError(error: unknown): boolean {
  const name: unknown = get(error, 'name');
  const code: unknown = get(error, 'code');
  return (
    includes(['NoHostAvailableError', 'OperationTimedOutError'], name) ||
    includes(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'], code)
  );
}

/** A fresh Client per attempt: a Client whose connect() failed is not reused (and see GOTCHA 14). */
async function connectWithRetry(
  build: () => CassandraClient,
  what: string,
  logger: Logger,
): Promise<CassandraClient> {
  return retry(
    async () => {
      const client = build();
      try {
        await client.connect();
        return client;
      } catch (error) {
        await client.shutdown().catch(noop);
        throw error;
      }
    },
    {
      retries: CONNECT_RETRIES,
      minDelayMs: 500,
      maxDelayMs: 5_000,
      shouldRetry: isTransientConnectError,
      onRetry: (error, attempt, delayMs) =>
        logger.warn(
          `Cassandra ${what} connect failed (attempt ${attempt}): ${String(error)} — retrying in ${delayMs}ms`,
        ),
    },
  );
}

/**
 * Boot sequence behind `CASSANDRA_CLIENT`:
 * 1. (runMigrations) a short-lived client WITHOUT keyspace runs `CREATE KEYSPACE IF NOT EXISTS`
 *    — a keyspace-bound client cannot even connect while the keyspace is missing;
 * 2. the long-lived client, bound to the keyspace, connects eagerly (fail fast at boot);
 * 3. (runMigrations) `CqlMigrator` applies pending `.cql` files through that client, so both
 *    qualified (`{keyspace}.t`) and unqualified table names work in migrations.
 */
export async function createCassandraClient(
  cfg: CassandraConfig,
  app: AppConfig,
  options: CassandraModuleOptions,
  logger: Logger = new Logger('CassandraModule'),
): Promise<CassandraClient> {
  const runMigrations = options.runMigrations ?? cfg.runMigrations;
  const context = { applicationName: app.serviceName };

  if (runMigrations) {
    const replication: CassandraReplication = options.replication ?? {
      class: 'SimpleStrategy',
      replicationFactor: cfg.replicationFactor,
    };
    const bootstrap = await connectWithRetry(
      () => new Client(buildClientOptions(cfg, context)),
      'bootstrap',
      logger,
    );
    try {
      await bootstrap.execute(createKeyspaceCql(cfg.keyspace, replication), [], {
        prepare: false,
      });
    } finally {
      await bootstrap.shutdown();
    }
  }

  const client = await connectWithRetry(
    () => {
      const created = new Client(buildClientOptions(cfg, { ...context, keyspace: cfg.keyspace }));
      attachDriverLogger(created, logger);
      return created;
    },
    'main',
    logger,
  );
  try {
    if (runMigrations && (options.migrations?.length ?? 0) > 0) {
      await new CqlMigrator(client, {
        keyspace: cfg.keyspace,
        sources: options.migrations ?? [],
        logger,
        ...(options.migrationLockTimeoutMs === undefined
          ? {}
          : { lockTimeoutMs: options.migrationLockTimeoutMs }),
      }).run();
    }
  } catch (error) {
    await client.shutdown().catch(noop);
    throw error;
  }
  logger.log(
    `Cassandra connected: keyspace "${cfg.keyspace}", DC "${cfg.localDataCenter}", ${cfg.contactPoints.length} contact point(s), consistency ${cfg.consistency}`,
  );
  return client;
}
