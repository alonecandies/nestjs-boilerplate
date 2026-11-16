import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startTestPostgres,
  TEST_POSTGRES_DEFAULT_STARTUP_TIMEOUT_MS,
  TEST_POSTGRES_IMAGE,
  testPostgresCommand,
  testPostgresStartupTimeoutMs,
  urlWithLogin,
} from './start-test-postgres.js';

const fake = vi.hoisted(() => ({ executed: [] as string[], urls: [] as string[] }));

vi.mock('@testcontainers/postgresql', () => ({
  PostgreSqlContainer: vi.fn(function PostgreSqlContainer(image: string) {
    throw new Error(`unit specs never start a container (${image})`);
  }),
}));

vi.mock('postgres', () => ({
  default: vi.fn((url: string) => {
    fake.urls.push(url);
    return {
      unsafe: (text: string) => ({
        simple: async () => {
          fake.executed.push(text);
          return [];
        },
      }),
      end: async () => undefined,
    };
  }),
}));

const EXTERNAL = 'postgres://owner:secret@db.internal:6543/scratch';

describe('@platform/testing/postgres', () => {
  beforeEach(() => {
    fake.executed.length = 0;
    fake.urls.length = 0;
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

  it('urlWithLogin swaps only the login and percent-encodes it, so postgres.js decodes it back', () => {
    const password = 'p@ss:w/rd%41 é#?';
    const parsed = new URL(urlWithLogin(EXTERNAL, 'app_runtime', password));
    expect(decodeURIComponent(parsed.username)).toBe('app_runtime');
    expect(decodeURIComponent(parsed.password)).toBe(password);
    expect(`${parsed.protocol}//${parsed.host}${parsed.pathname}`).toBe(
      'postgres://db.internal:6543/scratch',
    );
  });

  it('uses INTEGRATION_DATABASE_URL without a container and runs initSql there, in order', async () => {
    vi.stubEnv('INTEGRATION_DATABASE_URL', EXTERNAL);
    const pg = await startTestPostgres({
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
    await expect(startTestPostgres()).resolves.toMatchObject({ url: EXTERNAL });
    expect(fake.urls).toEqual([]);
  });

  it('starts a container when allowExternalUrl is false, or when the variable is empty', async () => {
    vi.stubEnv('INTEGRATION_DATABASE_URL', EXTERNAL);
    await expect(startTestPostgres({ allowExternalUrl: false })).rejects.toThrow(
      'unit specs never start a container (citusdata/citus:14.2.0)',
    );
    vi.stubEnv('INTEGRATION_DATABASE_URL', '');
    await expect(startTestPostgres()).rejects.toThrow('unit specs never start a container');
  });
});
