import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startTestPostgres,
  TEST_POSTGRES_DEFAULT_STARTUP_TIMEOUT_MS,
  TEST_POSTGRES_IMAGE,
  testPostgresClusterSql,
  testPostgresCommand,
  testPostgresHealthCheck,
  testPostgresStartupTimeoutMs,
  urlWithLogin,
} from './start-test-postgres.js';

const fake = vi.hoisted(() => ({
  executed: [] as string[],
  urls: [] as string[],
  /** `fake` mode: containers and the network are recorded instead of refused. */
  containers: false,
  events: [] as string[],
  aliases: [] as string[],
  environments: [] as Record<string, string>[],
  failSecondStart: false,
}));

vi.mock('@testcontainers/postgresql', () => ({
  PostgreSqlContainer: vi.fn(function PostgreSqlContainer(image: string) {
    if (!fake.containers) throw new Error(`unit specs never start a container (${image})`);
    const index = fake.aliases.length;
    const nameOf = (): string => fake.aliases[index] ?? 'unnamed';
    const builder = {
      withPlatform: () => builder,
      withDatabase: () => builder,
      withUsername: () => builder,
      withPassword: () => builder,
      withCommand: () => builder,
      withHealthCheck: () => builder,
      withStartupTimeout: () => builder,
      withNetwork: () => builder,
      withNetworkAliases: (alias: string) => {
        fake.aliases.push(alias);
        return builder;
      },
      withEnvironment: (environment: Record<string, string>) => {
        fake.environments.push(environment);
        return builder;
      },
      start: async () => {
        if (fake.failSecondStart && index === 1) throw new Error('worker did not start');
        fake.events.push(`start ${nameOf()}`);
        return {
          getConnectionUri: () => `postgres://app:app@${nameOf()}.test:5432/app`,
          stop: async () => {
            fake.events.push(`stop ${nameOf()}`);
          },
        };
      },
    };
    return builder;
  }),
}));

vi.mock('testcontainers', () => ({
  Network: vi.fn(function Network() {
    return {
      start: async () => ({
        stop: async () => {
          fake.events.push('stop network');
        },
      }),
    };
  }),
}));

vi.mock('postgres', () => ({
  default: vi.fn((url: string) => {
    fake.urls.push(url);
    // The Citus check is a tagged template; initSql and the cluster statements go through unsafe().
    return Object.assign(async () => [{ version: '14.2.0' }], {
      unsafe: (text: string) => ({
        simple: async () => {
          fake.executed.push(text);
          return [];
        },
      }),
      end: async () => undefined,
    });
  }),
}));

const EXTERNAL = 'postgres://owner:secret@db.internal:6543/scratch';

describe('@platform/testing/postgres', () => {
  beforeEach(() => {
    fake.executed.length = 0;
    fake.urls.length = 0;
    fake.events.length = 0;
    fake.aliases.length = 0;
    fake.environments.length = 0;
    fake.containers = false;
    fake.failSecondStart = false;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('pins the Citus 14.2 image the sharding design probed', () => {
    expect(TEST_POSTGRES_IMAGE).toBe('citusdata/citus:14.2.0');
  });

  it.each([
    [undefined, 'on'],
    [true, 'on'],
    [false, 'off'],
  ])('starts postgres with 4 shards; localExecution %s → %s', (localExecution, expected) => {
    expect(testPostgresCommand({ localExecution })).toEqual([
      'postgres',
      '-c',
      'citus.shard_count=4',
      '-c',
      `citus.enable_local_execution=${expected}`,
    ]);
  });

  it("waits testcontainers' 120 s for a healthy container unless TEST_POSTGRES_STARTUP_TIMEOUT_MS says otherwise", () => {
    expect(TEST_POSTGRES_DEFAULT_STARTUP_TIMEOUT_MS).toBe(120_000);
    expect(testPostgresStartupTimeoutMs({})).toBe(120_000);
    expect(testPostgresStartupTimeoutMs({ TEST_POSTGRES_STARTUP_TIMEOUT_MS: '' })).toBe(120_000);
    expect(testPostgresStartupTimeoutMs({ TEST_POSTGRES_STARTUP_TIMEOUT_MS: '360000' })).toBe(
      360_000,
    );
  });

  it.each(['abc', '0', '-5', '1.5', '1e3x'])(
    'refuses TEST_POSTGRES_STARTUP_TIMEOUT_MS=%s instead of silently using the default',
    (raw) => {
      expect(() => testPostgresStartupTimeoutMs({ TEST_POSTGRES_STARTUP_TIMEOUT_MS: raw })).toThrow(
        `TEST_POSTGRES_STARTUP_TIMEOUT_MS must be a positive integer (ms), got "${raw}"`,
      );
    },
  );

  it('probes health slowly enough for emulated Citus, so Docker never kills a probe under PID 1', () => {
    // testcontainers' default probe (every 250 ms, killed after 1 s) is slower than 1 s under amd64
    // emulation; the killed probe is reaped by postgres (PID 1), which then restarts every backend.
    const check = testPostgresHealthCheck();
    expect(check.test).toEqual([
      'CMD-SHELL',
      'PGPASSWORD=app pg_isready --host localhost --username app --dbname app',
    ]);
    expect(check.timeout).toBeGreaterThanOrEqual(10_000);
    expect(check.interval).toBeGreaterThanOrEqual(1_000);
    expect(check.retries).toBeGreaterThan(0);
  });

  it('urlWithLogin swaps only the login and percent-encodes it, so postgres.js decodes it back', () => {
    const password = 'p@ss:w/rd%41 é#?';
    const parsed = new URL(urlWithLogin(EXTERNAL, 'app_runtime', password));
    expect(decodeURIComponent(parsed.username)).toBe('app_runtime');
    expect(decodeURIComponent(parsed.password)).toBe(password);
    expect(`${parsed.protocol}//${parsed.host}${parsed.pathname}`).toBe(
      'postgres://db.internal:6543/scratch',
    );
  });

  it('with allowExternalUrl: true, uses INTEGRATION_DATABASE_URL without a container and runs initSql there, in order', async () => {
    vi.stubEnv('INTEGRATION_DATABASE_URL', EXTERNAL);
    const pg = await startTestPostgres({
      allowExternalUrl: true,
      localExecution: false,
      initSql: ['create role a', 'create role b; create role c'],
    });
    expect(pg.url).toBe(EXTERNAL);
    expect(fake.urls).toEqual([EXTERNAL]);
    expect(fake.executed).toEqual(['create role a', 'create role b; create role c']);
    expect(decodeURIComponent(new URL(pg.urlFor('app_system', 's3cret')).username)).toBe(
      'app_system',
    );
    await expect(pg.stop()).resolves.toBeUndefined();
    await expect(pg.stop()).resolves.toBeUndefined();
  });

  it('does not connect at all for INTEGRATION_DATABASE_URL without initSql', async () => {
    vi.stubEnv('INTEGRATION_DATABASE_URL', EXTERNAL);
    await expect(startTestPostgres({ allowExternalUrl: true })).resolves.toMatchObject({
      url: EXTERNAL,
    });
    expect(fake.urls).toEqual([]);
  });

  it('ignores INTEGRATION_DATABASE_URL by default: a container, never the shared database', async () => {
    vi.stubEnv('INTEGRATION_DATABASE_URL', EXTERNAL);
    await expect(startTestPostgres()).rejects.toThrow(
      'unit specs never start a container (citusdata/citus:14.2.0)',
    );
    await expect(startTestPostgres({ initSql: ['create role a'] })).rejects.toThrow(
      'unit specs never start a container',
    );
    expect(fake.urls).toEqual([]);
    expect(fake.executed).toEqual([]);
  });

  it('starts a container when allowExternalUrl is false, or when the variable is empty', async () => {
    vi.stubEnv('INTEGRATION_DATABASE_URL', EXTERNAL);
    await expect(startTestPostgres({ allowExternalUrl: false })).rejects.toThrow(
      'unit specs never start a container (citusdata/citus:14.2.0)',
    );
    vi.stubEnv('INTEGRATION_DATABASE_URL', '');
    await expect(startTestPostgres({ allowExternalUrl: true })).rejects.toThrow(
      'unit specs never start a container',
    );
    expect(fake.urls).toEqual([]);
  });
  it('joins the worker to the coordinator by alias: coordinator host first, then citus_add_node', () => {
    expect(testPostgresClusterSql(1)).toEqual([
      "select citus_set_coordinator_host('coordinator', 5432)",
      "select citus_add_node('worker1', 5432)",
    ]);
    expect(testPostgresClusterSql(0)).toEqual([]);
  });

  it.each([2, -1, 1.5])('refuses workers: %s (0 or 1 only)', async (workers) => {
    await expect(startTestPostgres({ workers: workers as 1 })).rejects.toThrow(
      'workers must be 0 or 1',
    );
    expect(fake.events).toEqual([]);
  });

  it('refuses workers: 1 with INTEGRATION_DATABASE_URL: an external database has no worker', async () => {
    vi.stubEnv('INTEGRATION_DATABASE_URL', EXTERNAL);
    await expect(startTestPostgres({ allowExternalUrl: true, workers: 1 })).rejects.toThrow(
      'workers: 1 needs a container',
    );
    expect(fake.urls).toEqual([]);
  });

  describe('workers: 1', () => {
    it('starts both nodes on one private network with trust, runs initSql on both, then joins them', async () => {
      fake.containers = true;
      const pg = await startTestPostgres({ workers: 1, initSql: ['create role a'] });
      expect(fake.aliases.sort()).toEqual(['coordinator', 'worker1']);
      expect(fake.environments).toEqual([
        { POSTGRES_HOST_AUTH_METHOD: 'trust' },
        { POSTGRES_HOST_AUTH_METHOD: 'trust' },
      ]);
      expect(pg.url).toBe('postgres://app:app@coordinator.test:5432/app');
      // The role script reaches the worker (its own connection) before the worker is added.
      expect(fake.urls).toEqual([
        'postgres://app:app@coordinator.test:5432/app',
        'postgres://app:app@worker1.test:5432/app',
        'postgres://app:app@coordinator.test:5432/app',
      ]);
      expect(fake.executed).toEqual([
        'create role a',
        'create role a',
        ...testPostgresClusterSql(1),
      ]);
      await pg.stop();
      expect(fake.events.slice(-3).sort()).toEqual(
        ['stop coordinator', 'stop network', 'stop worker1'].sort(),
      );
      expect(fake.events.at(-1)).toBe('stop network');
      await pg.stop();
      expect(fake.events.filter((event) => event === 'stop network')).toHaveLength(1);
    });

    it('stops the node and the network that did start when the other fails', async () => {
      fake.containers = true;
      fake.failSecondStart = true;
      await expect(startTestPostgres({ workers: 1 })).rejects.toThrow('worker did not start');
      expect(fake.events.filter((event) => event.startsWith('stop')).sort()).toEqual([
        'stop coordinator',
        'stop network',
      ]);
    });
  });
});
