import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';

/**
 * PostgreSQL 18.4 + Citus 14.2.0, the image the sharding design probed. amd64 only: on Apple Silicon
 * Docker Desktop runs it under emulation (pull it once: `docker pull --platform linux/amd64 <image>`).
 */
export const TEST_POSTGRES_IMAGE = 'citusdata/citus:14.2.0';
/** Shards per distributed table in specs. Citus' default is 32; fewer shards are faster to create. */
export const TEST_POSTGRES_SHARD_COUNT = 4;

export interface TestPostgresOptions {
  /**
   * `false` sets `citus.enable_local_execution=off`: even on one node, shard queries then go through
   * remote connections, so a setting that does not propagate to workers fails as it would on a
   * cluster (RLS specs). Default `true`, Citus' default. Not applied with `INTEGRATION_DATABASE_URL`.
   */
  localExecution?: boolean;
  /**
   * SQL run in order, as the container superuser, before `startTestPostgres` resolves (for example
   * B3's shared role script). An entry may hold several statements (simple protocol).
   */
  initSql?: readonly string[];
  /** Use `INTEGRATION_DATABASE_URL`, when set and not empty, instead of a container. Default `true`. */
  allowExternalUrl?: boolean;
}

export interface TestPostgres {
  /** Superuser URL of database `app` (user and password `app` in a container). */
  readonly url: string;
  /** `url` with another login, percent-encoded, for the roles that `initSql` creates. */
  urlFor(role: string, password: string): string;
  /** Stops the container; a no-op for `INTEGRATION_DATABASE_URL`. Safe to call twice. */
  stop(): Promise<void>;
}

/** The server command: Citus' shard count for specs and the local-execution switch. */
export function testPostgresCommand(
  options: Pick<TestPostgresOptions, 'localExecution'> = {},
): string[] {
  const localExecution = options.localExecution === false ? 'off' : 'on';
  return [
    'postgres',
    '-c',
    `citus.shard_count=${TEST_POSTGRES_SHARD_COUNT}`,
    '-c',
    `citus.enable_local_execution=${localExecution}`,
  ];
}

/**
 * `url` with `role` / `password` as its login. The URL setters leave `%` alone, so each part is
 * `encodeURIComponent`-ed first; postgres.js decodes both (`decodeURIComponent`) when it connects.
 */
export function urlWithLogin(url: string, role: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(role);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

/** Checks the container really has Citus, then runs `initSql`; connects only when there is work. */
async function prepareDatabase(
  url: string,
  initSql: readonly string[],
  requireCitus: boolean,
): Promise<void> {
  if (!requireCitus && initSql.length === 0) return;
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    if (requireCitus) {
      const [row] = await sql<{ version: string | null }[]>`
        select (select extversion from pg_extension where extname = 'citus') as version`;
      if (!row?.version) {
        throw new Error(
          `${TEST_POSTGRES_IMAGE} started without the citus extension in database app`,
        );
      }
    }
    for (const statement of initSql) await sql.unsafe(statement).simple();
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * A Postgres for one int spec: a fresh single-node Citus container (database, user and password
 * `app`), or the database at `INTEGRATION_DATABASE_URL` when that is set. The container's
 * healthcheck probes TCP, which the init-time server does not listen on, so it is ready only after
 * the image's init script created the extension (design P-14 note).
 */
export async function startTestPostgres(options: TestPostgresOptions = {}): Promise<TestPostgres> {
  const external =
    options.allowExternalUrl === false ? undefined : process.env['INTEGRATION_DATABASE_URL'];
  let container: StartedPostgreSqlContainer | undefined;
  let url: string;
  if (external !== undefined && external !== '') {
    url = external;
  } else {
    container = await new PostgreSqlContainer(TEST_POSTGRES_IMAGE)
      .withPlatform('linux/amd64')
      .withDatabase('app')
      .withUsername('app')
      .withPassword('app')
      .withCommand(testPostgresCommand(options))
      .start();
    url = container.getConnectionUri();
  }
  try {
    await prepareDatabase(url, options.initSql ?? [], container !== undefined);
  } catch (error) {
    await container?.stop();
    throw error;
  }
  let stopped = false;
  return {
    url,
    urlFor: (role, password) => urlWithLogin(url, role, password),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await container?.stop();
    },
  };
}
