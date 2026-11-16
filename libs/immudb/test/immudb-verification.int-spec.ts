import { generateKeyPairSync } from 'node:crypto';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createImmudbGrpcClient } from '../src/client/create-immudb-grpc-client.js';
import { GrpcImmudbClient } from '../src/client/grpc-immudb.client.js';
import { ImmudbSession } from '../src/client/immudb-session.js';
import { ImmudbSessionPool } from '../src/client/session-pool.js';
import type { ImmuServiceClient } from '../src/generated/immudb/schema/schema.pb.js';
import type { ImmudbState } from '../src/immudb.types.js';
import { IMMUDB_TEST_IMAGE } from '../src/index.js';

const ADMIN = { username: 'immudb', password: 'immudb', database: 'defaultdb' } as const;

async function start(signingKeyPem?: string): Promise<StartedTestContainer> {
  let container = new GenericContainer(IMMUDB_TEST_IMAGE)
    .withEnvironment({ IMMUDB_PGSQL_SERVER: 'false' })
    .withExposedPorts(3322, 9497)
    .withWaitStrategy(Wait.forHttp('/readyz', 9497));
  if (signingKeyPem !== undefined) {
    // SEC1 "EC PRIVATE KEY" PEM, as pkg/signer/ecdsa.go NewSigner parses it.
    container = container
      .withCopyContentToContainer([
        { content: signingKeyPem, target: '/keys/signing.key', mode: 0o644 },
      ])
      .withCommand(['--signingKey=/keys/signing.key']);
  }
  return container.start();
}

function clientFor(
  container: StartedTestContainer,
  options: { serverSigningPublicKeyPem?: string } = {},
): { client: GrpcImmudbClient; close: () => Promise<void> } {
  const grpc: ImmuServiceClient = createImmudbGrpcClient({
    address: `${container.getHost()}:${container.getMappedPort(3322)}`,
    tls: false,
  });
  const pool = new ImmudbSessionPool(() => ImmudbSession.open(grpc, ADMIN, 5_000), 2, 60_000);
  return {
    client: new GrpcImmudbClient(pool, options),
    close: async () => {
      await pool.close();
      grpc.close();
    },
  };
}

describe.skipIf(process.env['INTEGRATION'] !== '1')('immudb verification (real server)', () => {
  let plain: StartedTestContainer | undefined;
  let signed: StartedTestContainer | undefined;
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  beforeAll(async () => {
    [plain, signed] = await Promise.all([
      start(),
      start(keys.privateKey.export({ type: 'sec1', format: 'pem' }).toString()),
    ]);
  });

  afterAll(async () => {
    await Promise.all([plain?.stop(), signed?.stop()]);
  });

  it('proves consistency forward, rejects backwards and a tampered trusted hash', async () => {
    if (plain === undefined) throw new Error('container not started');
    const { client, close } = clientFor(plain);
    try {
      await client.readWrite((tx) =>
        tx.exec('CREATE TABLE IF NOT EXISTS vt (id VARCHAR[36], amount INTEGER, PRIMARY KEY id)'),
      );
      const trusted = await client.currentState();
      for (const id of ['a', 'b', 'c']) {
        await client.readWrite((tx) =>
          tx.exec('INSERT INTO vt (id, amount) VALUES (@id, @amount)', { id, amount: -5n }),
        );
      }
      const target = await client.currentState();
      await expect(client.verifyConsistency(trusted, target)).resolves.toBeUndefined();
      await expect(client.verifyConsistency(target, trusted)).rejects.toMatchObject({
        kind: 'verification-failed',
      });
      const tampered: ImmudbState = {
        ...trusted,
        txHash: Uint8Array.from(trusted.txHash, (b, i) => (i === 0 ? b ^ 1 : b)),
      };
      await expect(client.verifyConsistency(tampered, target)).rejects.toMatchObject({
        kind: 'verification-failed',
      });
      const fromOld = await client.verifiedRow('vt', ['b'], trusted);
      expect(fromOld.row).toEqual({ id: 'b', amount: -5n });
      expect(fromOld.state.txId).toBe(fromOld.txId);
      const fromNew = await client.verifiedRow('vt', ['b'], target);
      expect(fromNew.state.txId).toBe(target.txId);
      await expect(client.verifiedRow('vt', ['b'], tampered)).rejects.toMatchObject({
        kind: 'verification-failed',
      });
    } finally {
      await close();
    }
  });

  it('verifies signed states with the pinned key and rejects another key', async () => {
    if (signed === undefined) throw new Error('container not started');
    const { client, close } = clientFor(signed, { serverSigningPublicKeyPem: publicPem });
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    const wrong = clientFor(signed, { serverSigningPublicKeyPem: other });
    try {
      const first = await client.currentState();
      expect(first.signature).not.toBeNull();
      await client.readWrite((tx) =>
        tx.exec('CREATE TABLE IF NOT EXISTS st (id VARCHAR[8], PRIMARY KEY id)'),
      );
      const second = await client.currentState();
      await expect(client.verifyConsistency(first, second)).resolves.toBeUndefined();
      await expect(wrong.client.verifyConsistency(first, second)).rejects.toMatchObject({
        kind: 'verification-failed',
      });
      await client.readWrite((tx) => tx.exec("INSERT INTO st (id) VALUES ('x')"));
      const third = await client.currentState();
      const proven = await client.verifiedRow('st', ['x'], second);
      expect(proven.row).toEqual({ id: 'x' });
      expect(proven.state.signature).not.toBeNull();
      await expect(wrong.client.verifiedRow('st', ['x'], second)).rejects.toMatchObject({
        kind: 'verification-failed',
      });
      const ahead: ImmudbState = { ...third, txId: third.txId + 10n };
      await expect(client.verifiedRow('st', ['x'], ahead)).rejects.toMatchObject({
        kind: 'verification-failed',
        message: expect.stringContaining('ahead of the server'),
      });
    } finally {
      await Promise.all([close(), wrong.close()]);
    }
  });
});
