import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zInt, zUrl } from '../env/env.helpers.js';

export const databaseEnvSchema = z
  .object({
    DATABASE_URL: zUrl('postgres://app:app@localhost:5432/app', /^postgres(ql)?$/),
    DATABASE_POOL_MAX: zInt(20, { min: 1, max: 1000 }),
    DATABASE_IDLE_TIMEOUT_SEC: zInt(30, { min: 0 }),
    DATABASE_MAX_LIFETIME_SEC: zInt(1800, { min: 0 }),
    DATABASE_CONNECT_TIMEOUT_SEC: zInt(10, { min: 1 }),
    DATABASE_STATEMENT_TIMEOUT_MS: zInt(15_000, { min: 0 }),
    DATABASE_PREPARE: zBool(true),
    DATABASE_LOG_QUERIES: zBool(false),
    DATABASE_RUN_MIGRATIONS: zBool(false),
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
