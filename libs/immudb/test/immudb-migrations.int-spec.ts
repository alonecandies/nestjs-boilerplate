import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { AppConfigModule, immudbConfig } from '@platform/config';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createImmudbGrpcClient } from '../src/client/create-immudb-grpc-client.js';
import { GrpcImmudbClient } from '../src/client/grpc-immudb.client.js';
import { ImmudbClient } from '../src/client/immudb.client.js';
import { ImmudbSession } from '../src/client/immudb-session.js';
import { ImmudbSessionPool } from '../src/client/session-pool.js';
import { ImmudbModule } from '../src/immudb.module.js';
import { IMMUDB_TEST_IMAGE } from '../src/index.js';
import { runImmudbMigrations } from '../src/migrations/immudb-migrations.js';

const FIXTURES = join(import.meta.dirname, 'fixtures/migrations');

describe.skipIf(process.env['INTEGRATION'] !== '1')('immudb provisioning and migrations', () => {
  let container: StartedTestContainer | undefined;
  let address: string;

  const configFor = (database: string, extra: Record<string, string> = {}) =>
    immudbConfig.parse({
      IMMUDB_ADDRESS: address,
      IMMUDB_DATABASE: database,
      IMMUDB_ADMIN_PASSWORD: 'immudb',
      ...extra,
    });

  beforeAll(async () => {
    container = await new GenericContainer(IMMUDB_TEST_IMAGE)
      .withEnvironment({ IMMUDB_PGSQL_SERVER: 'false' })
      .withExposedPorts(3322, 9497)
      .withWaitStrategy(Wait.forHttp('/readyz', 9497))
      .start();
    address = `${container.getHost()}:${container.getMappedPort(3322)}`;
  });

  afterAll(async () => {
    await container?.stop();
  });

  it('provisions, applies once, then skips', async () => {
    const cfg = configFor('mig_once');
    const sources = [{ name: 'fixture', dir: FIXTURES }];
    await expect(runImmudbMigrations(cfg, sources)).resolves.toEqual({
      applied: ['fixture/001_kv.sql', 'fixture/002_kv_index.sql'],
      skipped: [],
    });
    await expect(runImmudbMigrations(cfg, sources)).resolves.toEqual({
      applied: [],
      skipped: ['fixture/001_kv.sql', 'fixture/002_kv_index.sql'],
    });
  });

  it('gives the application user SELECT and INSERT only', async () => {
    const cfg = configFor('mig_privileges');
    await runImmudbMigrations(cfg, [{ name: 'fixture', dir: FIXTURES }]);
    const grpc = createImmudbGrpcClient(cfg);
    const pool = new ImmudbSessionPool(
      () => ImmudbSession.open(grpc, { ...cfg.credentials, database: cfg.database }, 5_000),
      1,
      60_000,
    );
    const app = new GrpcImmudbClient(pool);
    try {
      await app.readWrite((tx) => tx.exec("INSERT INTO kv (id, n) VALUES ('a', 1)"));
      await expect(
        app.readOnly((tx) => tx.query("SELECT n FROM kv WHERE id = 'a'")),
      ).resolves.toEqual([{ n: 1n }]);
      for (const sql of [
        "UPDATE kv SET n = 2 WHERE id = 'a'",
        "DELETE FROM kv WHERE id = 'a'",
        "UPSERT INTO kv (id, n) VALUES ('a', 3)",
        'CREATE TABLE IF NOT EXISTS other (id VARCHAR[8], PRIMARY KEY id)',
      ]) {
        await expect(app.readWrite((tx) => tx.exec(sql))).rejects.toMatchObject({
          kind: 'access-denied',
        });
      }
    } finally {
      await pool.close();
      grpc.close();
    }
  });

  it('fails when an applied file changed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'immudb-mig-'));
    cpSync(FIXTURES, dir, { recursive: true });
    const cfg = configFor('mig_changed');
    await runImmudbMigrations(cfg, [{ name: 'fixture', dir }]);
    writeFileSync(join(dir, '002_kv_index.sql'), 'CREATE INDEX IF NOT EXISTS ON kv(id, n);\n');
    await expect(runImmudbMigrations(cfg, [{ name: 'fixture', dir }])).rejects.toThrow(
      /fixture\/002_kv_index\.sql changed after it was applied/,
    );
  });

  it('survives two concurrent runs (replicas booting together)', async () => {
    const cfg = configFor('mig_race');
    const sources = [{ name: 'fixture', dir: FIXTURES }];
    const [a, b] = await Promise.all([
      runImmudbMigrations(cfg, sources),
      runImmudbMigrations(cfg, sources),
    ]);
    expect([...a.applied, ...b.applied].sort()).toEqual([
      'fixture/001_kv.sql',
      'fixture/002_kv_index.sql',
    ]);
  });

  it('migrates at boot when IMMUDB_RUN_MIGRATIONS=true', async () => {
    vi.stubEnv('IMMUDB_ADDRESS', address);
    vi.stubEnv('IMMUDB_DATABASE', 'mig_boot');
    vi.stubEnv('IMMUDB_ADMIN_PASSWORD', 'immudb');
    vi.stubEnv('IMMUDB_RUN_MIGRATIONS', 'true');
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        ImmudbModule.forRootAsync({ migrations: [{ name: 'fixture', dir: FIXTURES }] }),
      ],
    }).compile();
    try {
      await expect(
        moduleRef.get(ImmudbClient).readOnly((tx) => tx.query('SELECT id FROM kv')),
      ).resolves.toEqual([]);
    } finally {
      await moduleRef.close();
      vi.unstubAllEnvs();
    }
  });
});
