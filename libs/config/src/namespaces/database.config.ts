import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zInt, zNodeEnv, zUrl } from '../env/env.helpers.js';
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

export const databaseEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    DATABASE_URL: zUrl('postgres://app:app@localhost:5432/app', /^postgres(ql)?$/),
    DATABASE_POOL_MAX: zInt(20, { min: 1, max: 1000 }),
    DATABASE_IDLE_TIMEOUT_SEC: zInt(30, { min: 0 }),
    DATABASE_MAX_LIFETIME_SEC: zInt(1800, { min: 0 }),
    DATABASE_CONNECT_TIMEOUT_SEC: zInt(10, { min: 1 }),
    DATABASE_STATEMENT_TIMEOUT_MS: zInt(15_000, { min: 0 }),
    DATABASE_PREPARE: zBool(true),
    DATABASE_LOG_QUERIES: zBool(false),
    DATABASE_RUN_MIGRATIONS: zBool(false),
    // Production refuses an unencrypted connection unless this explicit opt-out is set (a sidecar
    // such as the Cloud SQL Auth Proxy, or the network layer, already encrypts it).
    DATABASE_ALLOW_INSECURE: zBool(false),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production' || env.DATABASE_ALLOW_INSECURE) return;
    if (!ENCRYPTING_SSL_MODES.has(effectiveSslMode(env.DATABASE_URL) ?? '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message:
          'DATABASE_URL must enable TLS in production: add ?sslmode=verify-full (or require / verify-ca, ssl=true, or sslrootcert=system; prefer and allow can fall back to plaintext), or set DATABASE_ALLOW_INSECURE=true when a sidecar proxy or the network layer encrypts the connection',
      });
    }
  })
  .transform((env) => ({
    url: env.DATABASE_URL,
    poolMax: env.DATABASE_POOL_MAX,
    /** postgres.js time options are SECONDS… */
    idleTimeoutSec: env.DATABASE_IDLE_TIMEOUT_SEC,
    maxLifetimeSec: env.DATABASE_MAX_LIFETIME_SEC,
    connectTimeoutSec: env.DATABASE_CONNECT_TIMEOUT_SEC,
    /** …while Postgres GUCs such as statement_timeout are MILLISECONDS. */
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    /** Server-side prepared statements; set `false` behind PgBouncer (transaction mode) / RDS Proxy. */
    prepare: env.DATABASE_PREPARE,
    logQueries: env.DATABASE_LOG_QUERIES,
    runMigrations: env.DATABASE_RUN_MIGRATIONS,
  }));

/** PostgreSQL (postgres.js + Drizzle) connection pool. */
export const databaseConfig = defineConfigNamespace('database', databaseEnvSchema);
export type DatabaseConfig = ConfigType<typeof databaseConfig>;
