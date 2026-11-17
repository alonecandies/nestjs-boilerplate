import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestPostgres, type TestPostgres } from './start-test-postgres.js';

/** The three database roles that `docker/postgres/init/02-roles.sql` creates (program spec section 4). */
export const TEST_DB_ROLES = Object.freeze({
  owner: 'app_owner',
  runtime: 'app_runtime',
  system: 'app_system',
} as const);

/**
 * The repository's init folder: `src/postgres` and `dist/postgres` are both four levels below the
 * root, so the source and the built module read the same files.
 */
const ROLES_INIT_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'docker',
  'postgres',
  'init',
);
/** In this order: the lookup function in 03 reads the roles of 02. */
const ROLES_INIT_FILES = ['02-roles.sql', '03-pgbouncer-auth.sql'] as const;

/**
 * The role script that compose runs on a fresh volume, as `initSql` entries (each file is one
 * simple-protocol string). The same files, so a spec can never drift from compose and CI.
 */
export function readRolesInitSql(): readonly string[] {
  return ROLES_INIT_FILES.map((file) => readFileSync(join(ROLES_INIT_DIR, file), 'utf8'));
}

export interface RlsTestPostgres extends TestPostgres {
  /** `app_owner`: migrations, drizzle-kit and CLIs. */
  readonly migrationUrl: string;
  /** `app_runtime` (NOBYPASSRLS): what every request runs as. */
  readonly runtimeUrl: string;
  /** `app_system` (BYPASSRLS): the named system methods. */
  readonly systemUrl: string;
}

/**
 * The Postgres of every spec that asserts isolation: a fresh container (never
 * `INTEGRATION_DATABASE_URL`), local execution off by default (a context that does not reach a shard
 * fails as on a cluster), and the three roles. `url` stays the superuser, for seeding. Dev passwords
 * equal the role names (02-roles.sql). `workers: 1` adds a Citus worker with the roles on it too.
 */
export async function startRlsTestPostgres(
  options: { localExecution?: boolean; workers?: 0 | 1 } = {},
): Promise<RlsTestPostgres> {
  const pg = await startTestPostgres({
    localExecution: options.localExecution ?? false,
    allowExternalUrl: false,
    initSql: readRolesInitSql(),
    ...(options.workers === undefined ? {} : { workers: options.workers }),
  });
  const urlOf = (role: string): string => pg.urlFor(role, role);
  return {
    url: pg.url,
    urlFor: (role, password) => pg.urlFor(role, password),
    stop: () => pg.stop(),
    migrationUrl: urlOf(TEST_DB_ROLES.owner),
    runtimeUrl: urlOf(TEST_DB_ROLES.runtime),
    systemUrl: urlOf(TEST_DB_ROLES.system),
  };
}
