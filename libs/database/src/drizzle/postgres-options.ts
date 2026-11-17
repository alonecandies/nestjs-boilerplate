import type { DatabaseConfig } from '@platform/config';
import { get, includes, isNil, merge, noop } from 'lodash-es';
import type { Notice, Options, PostgresType } from 'postgres';

/** postgres.js client options (the library's own `Options<T>`, with the default type map). */
export type PostgresOptions = Options<Record<string, PostgresType>>;

export interface PostgresOptionsContext {
  /** Reported as `application_name` → visible in `pg_stat_activity`, slow-query logs, pgBadger. */
  applicationName: string;
  /** Where server NOTICEs go (postgres.js prints them with console.log by default). */
  onNotice?: (notice: Notice) => void;
  /**
   * Which pool: `runtime` (default; `DATABASE_POOL_MAX`) or `system` (`DATABASE_SYSTEM_POOL_MAX`,
   * `application_name` suffixed with `:system` so its sessions stand out in `pg_stat_activity`).
   */
  pool?: 'runtime' | 'system';
}

/**
 * A transaction left open (a bug: missing commit, awaited HTTP call inside a tx…) holds row locks
 * and blocks VACUUM. Postgres kills such sessions after this long; the pool replaces the socket.
 */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * Maps the `database` config namespace onto a tuned postgres.js pool (research data-libs §1.4).
 * Time units differ on purpose: postgres.js' own timeouts are SECONDS, Postgres GUCs sent as
 * startup parameters (`connection`) are MILLISECONDS. `0` in config means "disabled".
 * Behind PgBouncer (`pooler: 'pgbouncer'`) the two timeouts are not sent: PgBouncer rejects them
 * as startup parameters (08P01), and the roles carry the same values (`ALTER ROLE … SET`).
 * `application_name` and `TimeZone` pass through it.
 * `overrides` are deep-merged last (escape hatch: TLS objects, `target_session_attrs`, tests).
 */
export function buildPostgresOptions(
  cfg: DatabaseConfig,
  ctx: PostgresOptionsContext,
  overrides?: PostgresOptions,
): PostgresOptions {
  const system = ctx.pool === 'system';
  const timeouts =
    cfg.pooler === 'pgbouncer'
      ? {}
      : {
          statement_timeout: cfg.statementTimeoutMs,
          idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
        };
  const base: PostgresOptions = {
    max: system ? cfg.systemPoolMax : cfg.poolMax,
    idle_timeout: cfg.idleTimeoutSec > 0 ? cfg.idleTimeoutSec : undefined,
    // `null` = never recycle; 0 would make postgres.js recycle every connection immediately.
    max_lifetime: cfg.maxLifetimeSec > 0 ? cfg.maxLifetimeSec : null,
    connect_timeout: cfg.connectTimeoutSec,
    // Auto-named server-side prepared statements per connection (keyed by SQL text). PgBouncer
    // 1.26 tracks them (`max_prepared_statements`); DATABASE_PREPARE=false is the escape hatch
    // for poolers that do not (RDS Proxy).
    prepare: cfg.prepare,
    onnotice: ctx.onNotice ?? noop,
    connection: {
      application_name: system ? `${ctx.applicationName}:system` : ctx.applicationName,
      ...timeouts,
      // Deterministic now()::date / date_trunc regardless of the server's default zone.
      TimeZone: 'UTC',
    },
  };
  return isNil(overrides) ? base : merge(base, overrides);
}

/** Error codes worth retrying while the database is still coming up (boot, failover). */
const TRANSIENT_CONNECTION_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  '57P03', // cannot_connect_now (server starting up / recovering)
  '53300', // too_many_connections (another replica is draining)
] as const;

/**
 * True for connection-level failures that may heal by themselves. Auth failures (28P01),
 * unknown database (3D000) and SQL errors are NOT transient — retrying them only delays the crash.
 */
export function isTransientConnectionError(error: unknown): boolean {
  const code: unknown = get(error, 'code');
  return typeof code === 'string' && includes(TRANSIENT_CONNECTION_CODES, code);
}

/** `host:port/database` of a connection URL — for logs; never log the URL itself (credentials). */
export function describePostgresUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return '<invalid DATABASE_URL>';
  }
}
