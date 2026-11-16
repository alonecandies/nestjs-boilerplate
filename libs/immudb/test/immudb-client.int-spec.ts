import { Test } from '@nestjs/testing';
import { AppConfigModule } from '@platform/config';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createImmudbGrpcClient } from '../src/client/create-immudb-grpc-client.js';
import { GrpcImmudbClient } from '../src/client/grpc-immudb.client.js';
import { ImmudbClient } from '../src/client/immudb.client.js';
import { ImmudbSession } from '../src/client/immudb-session.js';
import { ImmudbSessionPool } from '../src/client/session-pool.js';
import type { ImmudbError } from '../src/errors/immudb.error.js';
import { type ImmuServiceClient, TxMode } from '../src/generated/immudb/schema/schema.pb.js';
import { ImmudbHealthIndicator } from '../src/health/immudb.health.js';
import { ImmudbModule } from '../src/immudb.module.js';
import type { ImmudbTx } from '../src/immudb.types.js';
import { IMMUDB_TEST_IMAGE } from '../src/index.js';

const ADMIN = { username: 'immudb', password: 'immudb', database: 'defaultdb' } as const;
const TIMEOUT_MS = 5_000;

describe.skipIf(process.env['INTEGRATION'] !== '1')('immudb client against immudb 1.11.2', () => {
  let container: StartedTestContainer | undefined;
  let address: string;
  let grpc: ImmuServiceClient;
  const opened: ImmudbSession[] = [];
  let pool: ImmudbSessionPool;
  let client: GrpcImmudbClient;

  beforeAll(async () => {
    container = await new GenericContainer(IMMUDB_TEST_IMAGE)
      .withEnvironment({ IMMUDB_PGSQL_SERVER: 'false' })
      .withExposedPorts(3322, 9497)
      .withWaitStrategy(Wait.forHttp('/readyz', 9497))
      .start();
    address = `${container.getHost()}:${container.getMappedPort(3322)}`;
    grpc = createImmudbGrpcClient({ address, tls: false });
    pool = new ImmudbSessionPool(
      async () => {
        const session = await ImmudbSession.open(grpc, ADMIN, TIMEOUT_MS);
        opened.push(session);
        return session;
      },
      1,
      60_000,
    );
    client = new GrpcImmudbClient(pool);
    await client.readWrite((tx) =>
      tx.exec('CREATE TABLE IF NOT EXISTS kv (id VARCHAR[64], n INTEGER, PRIMARY KEY id)'),
    );
  });

  afterAll(async () => {
    await pool?.close();
    grpc?.close();
    await container?.stop();
  });

  const insert = (id: string, n: bigint) => (tx: ImmudbTx) =>
    tx.exec('INSERT INTO kv (id, n) VALUES (@id, @n)', { id, n });

  it('commits, returns the tx id and reads int64 extremes back at that snapshot', async () => {
    const { txId } = await client.readWrite(async (tx) => {
      await insert('big', 9007199254740993n)(tx);
      await insert('neg', -1n)(tx);
    });
    expect(txId).toBeGreaterThan(0n);
    const rows = await client.readOnly(
      (tx) =>
        tx.query<{ id: string; n: bigint }>(
          'SELECT id, n FROM kv WHERE id = @a OR id = @b ORDER BY id',
          { a: 'big', b: 'neg' },
        ),
      { mustIncludeTxId: txId ?? 0n },
    );
    expect(rows).toEqual([
      { id: 'big', n: 9007199254740993n },
      { id: 'neg', n: -1n },
    ]);
  });

  it('returns no tx id when the work wrote nothing', async () => {
    await expect(
      client.readWrite((tx) => tx.query('SELECT id FROM kv WHERE id = @id', { id: 'none' })),
    ).resolves.toEqual({ result: [], txId: null });
  });

  it('surfaces duplicate-key, not tx-closed, and keeps the session usable', async () => {
    await client.readWrite(insert('dup', 1n));
    const sessionsBefore = opened.length;
    await expect(client.readWrite(insert('dup', 2n))).rejects.toMatchObject({
      kind: 'duplicate-key',
    });
    await expect(
      client.readOnly((tx) => tx.query('SELECT n FROM kv WHERE id = @id', { id: 'dup' })),
    ).resolves.toEqual([{ n: 1n }]);
    expect(opened).toHaveLength(sessionsBefore);
  });

  it('reports tx-closed for a statement after a failed one', async () => {
    await expect(
      client.readWrite(async (tx) => {
        await insert('dup', 3n)(tx).catch(() => undefined);
        await insert('after-failure', 1n)(tx);
      }),
    ).rejects.toMatchObject({ kind: 'tx-closed' });
  });

  it('refuses writes in a read-only transaction', async () => {
    await expect(client.readOnly(insert('ro', 1n))).rejects.toMatchObject({ kind: 'read-only' });
  });

  it('lets exactly one of two racing read-check-insert transactions win', async () => {
    const racePool = new ImmudbSessionPool(
      () => ImmudbSession.open(grpc, ADMIN, TIMEOUT_MS),
      2,
      60_000,
    );
    const racing = new GrpcImmudbClient(racePool);
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const post = () =>
      racing.readWrite(async (tx) => {
        const seen = await tx.query('SELECT id FROM kv WHERE id = @id', { id: 'race' });
        if (++arrived === 2) open();
        await gate;
        if (seen.length === 0) await insert('race', 1n)(tx);
      });
    const results = await Promise.allSettled([post(), post()]);
    await racePool.close();
    const reasons = results.flatMap((r) =>
      r.status === 'rejected' ? [r.reason as ImmudbError] : [],
    );
    expect(reasons).toHaveLength(1);
    expect(['read-conflict', 'duplicate-key']).toContain(reasons[0]?.kind);
  });

  it('pins the raw selectors of a column, an alias and aliased aggregates', async () => {
    const session = await ImmudbSession.open(grpc, ADMIN, TIMEOUT_MS);
    const id = await session.newTx(TxMode.ReadOnly);
    const plain = await session.txQueryRaw(id, 'SELECT id, n AS amount FROM kv WHERE id = @id', {
      id: 'big',
    });
    const grouped = await session.txQueryRaw(
      id,
      'SELECT COUNT(*) AS rows_total, SUM(n) AS n_total FROM kv',
    );
    await session.rollback(id);
    await session.close();
    // If these fail, immudb's selector format differs from 1.11 EncodeSelector: adapt `columnKey`
    // and its unit table to the observed format; never work around it in queries.
    expect(plain[0]?.rows[0]?.columns).toEqual(['(kv.id)', '(kv.amount)']);
    expect(grouped[0]?.rows[0]?.columns).toEqual(['(kv.rows_total)', '(kv.n_total)']);
  });

  it('replaces a session the server forgot and retries the transaction once', async () => {
    const before = opened.length;
    await opened.at(-1)?.close(); // behind the pool's back
    await expect(
      client.readOnly((tx) => tx.query('SELECT id FROM kv WHERE id = @id', { id: 'big' })),
    ).resolves.toEqual([{ id: 'big' }]);
    expect(opened).toHaveLength(before + 1);
  });

  it('serves ImmudbClient and a ready health contributor through ImmudbModule', async () => {
    vi.stubEnv('IMMUDB_ADDRESS', address);
    vi.stubEnv('IMMUDB_DATABASE', 'defaultdb');
    vi.stubEnv('IMMUDB_USERNAME', 'immudb');
    vi.stubEnv('IMMUDB_PASSWORD', 'immudb');
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot(), ImmudbModule.forRootAsync()],
    }).compile();
    try {
      await expect(moduleRef.get(ImmudbClient).currentState()).resolves.toMatchObject({
        database: 'defaultdb',
      });
      await expect(moduleRef.get(ImmudbHealthIndicator).check()).resolves.toMatchObject({
        immudb: { status: 'up' },
      });
    } finally {
      await moduleRef.close();
      vi.unstubAllEnvs();
    }
  });
});
