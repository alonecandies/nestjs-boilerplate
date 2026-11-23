import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zEnum, zInt, zNodeEnv, zUrl } from '../env/env.helpers.js';
import { parseUrl } from '../env/production-guards.js';

/** Modes that always encrypt: `prefer` and `allow` may fall back to plaintext without a word. */
const ENCRYPTING_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full', 'true']);

/**
 * The TLS mode postgres.js will actually use for this URL (its `parseOptions`): the LAST value of a
 * repeated parameter wins, a non-empty `sslmode` overrides `ssl`, and `sslrootcert=system`
 * overrides both with `verify-full`. A code-level `postgres.ssl` option (DatabaseModule) wins at
 * runtime, but this check only sees the URL: keep `?sslmode=require` there too.
 */
function effectiveSslMode(databaseUrl: string): string | undefined {
  const params = parseUrl(databaseUrl)?.searchParams;
  const last = (key: string): string | undefined => params?.getAll(key).at(-1);
  if (last('sslrootcert') === 'system') return 'verify-full';
  const sslmode = last('sslmode');
  return sslmode !== undefined && sslmode !== '' ? sslmode : last('ssl');
}

/** `postgres://` or `postgresql://`, the only schemes postgres.js reads. */
const POSTGRES_PROTOCOL = /^postgres(ql)?$/;

/** Who reaches the database, and through what (sharding design §5). */
export const DATABASE_POOLERS = ['none', 'pgbouncer'] as const;
export const DATABASE_BOOT_GUARD_MODES = ['enforce', 'warn', 'off'] as const;

/** The three URL keys, each checked for TLS in production. */
const URL_KEYS = ['DATABASE_URL', 'DATABASE_SYSTEM_URL', 'DATABASE_MIGRATION_URL'] as const;

/** The user postgres.js logs in as (percent-decoded); `undefined` for an unparsable URL. */
function userOf(databaseUrl: string): string | undefined {
  const parsed = parseUrl(databaseUrl);
  if (parsed === undefined) return undefined;
  try {
    return decodeURIComponent(parsed.username);
  } catch {
    return parsed.username;
  }
}

/** `host:port` as a client dials it: lower-cased host, port 5432 when the URL names none. */
function addressOf(databaseUrl: string): string | undefined {
  const parsed = parseUrl(databaseUrl);
  if (parsed === undefined) return undefined;
  return `${parsed.hostname.toLowerCase().replace(/\.$/, '')}:${parsed.port || '5432'}`;
}

const databaseEnvObject = z.object({
  NODE_ENV: zNodeEnv(),
  // app_runtime (NOBYPASSRLS); through PgBouncer when DATABASE_POOLER=pgbouncer.
  DATABASE_URL: zUrl('postgres://app:app@localhost:5432/app', POSTGRES_PROTOCOL),
  // app_system (BYPASSRLS), the named system methods only. Without it there is no system pool
  // (development and tests only: production requires it, see below).
  DATABASE_SYSTEM_URL: zUrl(undefined, POSTGRES_PROTOCOL),
  // app_owner, directly to the coordinator: the migrator, drizzle-kit and the operator CLIs.
  // Never replaced by DATABASE_URL: a missing value fails where it is needed.
  DATABASE_MIGRATION_URL: zUrl(undefined, POSTGRES_PROTOCOL),
  DATABASE_POOL_MAX: zInt(20, { min: 1, max: 1000 }),
  DATABASE_SYSTEM_POOL_MAX: zInt(5, { min: 1, max: 5 }),
  DATABASE_POOLER: zEnum(DATABASE_POOLERS, 'none'),
  DATABASE_BOOT_GUARD: zEnum(DATABASE_BOOT_GUARD_MODES),
  DATABASE_IDLE_TIMEOUT_SEC: zInt(30, { min: 0 }),
  DATABASE_MAX_LIFETIME_SEC: zInt(1800, { min: 0 }),
  DATABASE_CONNECT_TIMEOUT_SEC: zInt(10, { min: 1 }),
  DATABASE_STATEMENT_TIMEOUT_MS: zInt(15_000, { min: 0 }),
  DATABASE_PREPARE: zBool(true),
  DATABASE_LOG_QUERIES: zBool(false),
  DATABASE_RUN_MIGRATIONS: zBool(false),
  // The migration session's Postgres lock_timeout (0 = wait without limit) and how many times a set
  // that hit it (55P03) is retried with backoff before the run fails (OPS-2).
  DATABASE_MIGRATION_LOCK_TIMEOUT_MS: zInt(5_000, { min: 0 }),
  DATABASE_MIGRATION_LOCK_RETRIES: zInt(5, { min: 0, max: 100 }),
  // The lock_timeout of the session that runs a set's online steps (CREATE INDEX CONCURRENTLY…):
  // 0 = wait, since a lock timeout cancels a concurrent build and leaves an invalid index (OPS-2).
  DATABASE_MIGRATION_ONLINE_LOCK_TIMEOUT_MS: zInt(0, { min: 0 }),
  // Production refuses an unencrypted connection unless this explicit opt-out is set (a sidecar
  // such as the Cloud SQL Auth Proxy, or the network layer, already encrypts it).
  DATABASE_ALLOW_INSECURE: zBool(false),
});

type DatabaseEnv = z.infer<typeof databaseEnvObject>;

/**
 * The production rules. `requireSystemUrl`: an app process opens the system pool (login, register,
 * accepting an invitation and the purge jobs run on it), so production refuses to start without
 * it; the migrate job (`databaseMigrationEnvSchema`) never opens it.
 */
function refineProduction(
  env: DatabaseEnv,
  ctx: z.RefinementCtx,
  { requireSystemUrl }: { requireSystemUrl: boolean },
): void {
  if (env.NODE_ENV !== 'production') return;
  // Error messages name keys and roles only, never a URL: URLs carry passwords.
  const fail = (key: string, message: string): void => {
    ctx.addIssue({ code: 'custom', path: [key], message });
  };

  if (env.DATABASE_BOOT_GUARD !== undefined && env.DATABASE_BOOT_GUARD !== 'enforce') {
    fail(
      'DATABASE_BOOT_GUARD',
      'DATABASE_BOOT_GUARD must be enforce in production (warn and off are for development and tests)',
    );
  }
  if (requireSystemUrl && env.DATABASE_SYSTEM_URL === undefined) {
    fail(
      'DATABASE_SYSTEM_URL',
      'DATABASE_SYSTEM_URL is required in production (the app_system role): login, register, accepting an invitation and the purge jobs run on the system pool',
    );
  }
  if (env.DATABASE_RUN_MIGRATIONS && env.DATABASE_MIGRATION_URL === undefined) {
    fail(
      'DATABASE_MIGRATION_URL',
      'DATABASE_RUN_MIGRATIONS=true needs DATABASE_MIGRATION_URL in production (the app_owner role, directly to the coordinator); migrations never use DATABASE_URL',
    );
  }
  const runtimeUser = userOf(env.DATABASE_URL);
  for (const key of ['DATABASE_SYSTEM_URL', 'DATABASE_MIGRATION_URL'] as const) {
    const value = env[key];
    if (value !== undefined && userOf(value) === runtimeUser) {
      fail(
        key,
        `${key} must log in as another user than DATABASE_URL (app_runtime; app_system for the system pool, app_owner for migrations)`,
      );
    }
  }
  if (
    env.DATABASE_POOLER === 'pgbouncer' &&
    env.DATABASE_MIGRATION_URL !== undefined &&
    addressOf(env.DATABASE_MIGRATION_URL) === addressOf(env.DATABASE_URL)
  ) {
    fail(
      'DATABASE_MIGRATION_URL',
      'DATABASE_MIGRATION_URL must connect directly to the coordinator, not through PgBouncer: with DATABASE_POOLER=pgbouncer it cannot use the host and port of DATABASE_URL (the migrator holds a session advisory lock)',
    );
  }

  if (env.DATABASE_ALLOW_INSECURE) return;
  for (const key of URL_KEYS) {
    const value = env[key];
    if (value !== undefined && !ENCRYPTING_SSL_MODES.has(effectiveSslMode(value) ?? '')) {
      fail(
        key,
        `${key} must enable TLS in production: add ?sslmode=verify-full (or require / verify-ca, ssl=true, or sslrootcert=system; prefer and allow can fall back to plaintext), or set DATABASE_ALLOW_INSECURE=true when a sidecar proxy or the network layer encrypts the connection`,
      );
    }
  }
}

const toDatabaseConfig = (env: DatabaseEnv) => ({
  /** app_runtime: every request. */
  url: env.DATABASE_URL,
  /** app_system: the named system methods; `undefined` = no system pool (never in production). */
  systemUrl: env.DATABASE_SYSTEM_URL,
  /** app_owner, direct to the coordinator; required wherever migrations or CLIs run. */
  migrationUrl: env.DATABASE_MIGRATION_URL,
  poolMax: env.DATABASE_POOL_MAX,
  systemPoolMax: env.DATABASE_SYSTEM_POOL_MAX,
  /**
   * `pgbouncer`: the client stops sending `statement_timeout` and
   * `idle_in_transaction_session_timeout` as startup parameters (PgBouncer rejects them); the
   * roles carry the same values (`ALTER ROLE … SET`).
   */
  pooler: env.DATABASE_POOLER,
  /** What the boot guard does with its findings: enforce in production, warn elsewhere. */
  bootGuard: env.DATABASE_BOOT_GUARD ?? (env.NODE_ENV === 'production' ? 'enforce' : 'warn'),
  /** postgres.js time options are SECONDS… */
  idleTimeoutSec: env.DATABASE_IDLE_TIMEOUT_SEC,
  maxLifetimeSec: env.DATABASE_MAX_LIFETIME_SEC,
  connectTimeoutSec: env.DATABASE_CONNECT_TIMEOUT_SEC,
  /** …while Postgres GUCs such as statement_timeout are MILLISECONDS. */
  statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
  /**
   * Server-side prepared statements. Stays `true` behind PgBouncer 1.26 (it tracks them,
   * `max_prepared_statements`); `false` is the escape hatch for poolers that do not (RDS Proxy).
   */
  prepare: env.DATABASE_PREPARE,
  logQueries: env.DATABASE_LOG_QUERIES,
  runMigrations: env.DATABASE_RUN_MIGRATIONS,
  /**
   * Migrations (release job and boot alike): `lock_timeout` of the migration session in
   * MILLISECONDS, sent as a startup parameter and, on Citus, kept as the migration role's default so
   * worker connections inherit it; 0 = no limit.
   */
  migrationLockTimeoutMs: env.DATABASE_MIGRATION_LOCK_TIMEOUT_MS,
  /** Retries, with backoff and under the same advisory lock, of a set that hit the lock timeout. */
  migrationLockRetries: env.DATABASE_MIGRATION_LOCK_RETRIES,
  /**
   * `lock_timeout` in MILLISECONDS of the separate session that runs the sets' online steps; on
   * Citus also the role default while they run. 0 (default) = wait: these statements take no lock
   * that blocks traffic, and a timeout would cancel a concurrent build half-way.
   */
  migrationOnlineLockTimeoutMs: env.DATABASE_MIGRATION_ONLINE_LOCK_TIMEOUT_MS,
});

/** The app processes' schema: every production rule, DATABASE_SYSTEM_URL required. */
export const databaseEnvSchema = databaseEnvObject
  .superRefine((env, ctx) => refineProduction(env, ctx, { requireSystemUrl: true }))
  .transform(toDatabaseConfig);

/**
 * The migrate job's schema (`runMigrationsCli`, the `database` namespace too): the same rules and
 * messages, but it never opens the system pool, so production does not require DATABASE_SYSTEM_URL.
 */
export const databaseMigrationEnvSchema = databaseEnvObject
  .superRefine((env, ctx) => refineProduction(env, ctx, { requireSystemUrl: false }))
  .transform(toDatabaseConfig);

/** PostgreSQL (postgres.js + Drizzle) connection pool. */
export const databaseConfig = defineConfigNamespace('database', databaseEnvSchema);
export type DatabaseConfig = ConfigType<typeof databaseConfig>;
