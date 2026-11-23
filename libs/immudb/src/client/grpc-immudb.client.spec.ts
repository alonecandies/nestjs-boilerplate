import { Metadata, status } from '@grpc/grpc-js';
import { createMock, type Mocked } from '@platform/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { TxHeader, TxMode } from '../generated/immudb/schema/schema.pb.js';
import { GrpcImmudbClient } from './grpc-immudb.client.js';
import type { ImmudbSession } from './immudb-session.js';
import { ImmudbSessionPool } from './session-pool.js';

const grpcError = (details: string): Error =>
  Object.assign(new Error(details), { code: status.UNKNOWN, details, metadata: new Metadata() });

describe('GrpcImmudbClient', () => {
  let sessions: Mocked<ImmudbSession>[];
  let client: GrpcImmudbClient;

  const newSession = (): Mocked<ImmudbSession> => {
    const session = createMock<ImmudbSession>();
    session.newTx.mockResolvedValue('tx-1');
    session.txExec.mockResolvedValue(undefined);
    session.txQuery.mockResolvedValue([]);
    session.rollback.mockResolvedValue(undefined);
    session.close.mockResolvedValue(undefined);
    session.commit.mockResolvedValue({
      header: undefined,
      updatedRows: 1,
      lastInsertedPKs: {},
      firstInsertedPKs: {},
    });
    sessions.push(session);
    return session;
  };

  beforeEach(() => {
    sessions = [];
    const pool = new ImmudbSessionPool(
      async () => newSession() as unknown as ImmudbSession,
      1,
      60_000,
    );
    client = new GrpcImmudbClient(pool);
  });

  it('commits after an exec and returns the committed tx id', async () => {
    const result = client.readWrite(async (tx) => {
      sessions[0]?.commit.mockResolvedValueOnce({
        header: TxHeader.fromPartial({ id: '42' }),
        updatedRows: 1,
        lastInsertedPKs: {},
        firstInsertedPKs: {},
      });
      await tx.exec('INSERT', { a: 1n });
      return 'ok';
    });
    await expect(result).resolves.toEqual({ result: 'ok', txId: 42n });
    const [session] = sessions;
    expect(session?.newTx).toHaveBeenCalledWith(TxMode.ReadWrite, undefined);
    expect(session?.commit).toHaveBeenCalledWith('tx-1');
    expect(session?.rollback).not.toHaveBeenCalled();
  });

  it('rolls back instead of committing when nothing was written', async () => {
    await expect(client.readWrite(async () => 1)).resolves.toEqual({ result: 1, txId: null });
    expect(sessions[0]?.rollback).toHaveBeenCalledWith('tx-1');
    expect(sessions[0]?.commit).not.toHaveBeenCalled();
  });

  it('never rolls back after a failed statement and surfaces the original error', async () => {
    const work = client.readWrite(async (tx) => {
      sessions[0]?.txExec.mockRejectedValueOnce(grpcError('key already exists'));
      await tx.exec('INSERT');
    });
    await expect(work).rejects.toMatchObject({ kind: 'duplicate-key' });
    expect(sessions[0]?.rollback).not.toHaveBeenCalled();
  });

  it('rolls back after an application error', async () => {
    await expect(
      client.readWrite(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(sessions[0]?.rollback).toHaveBeenCalledWith('tx-1');
  });

  it('passes the snapshot floor of a read-only transaction', async () => {
    await client.readOnly(async () => undefined, { mustIncludeTxId: 7n });
    expect(sessions[0]?.newTx).toHaveBeenCalledWith(TxMode.ReadOnly, 7n);
    expect(sessions[0]?.rollback).toHaveBeenCalledWith('tx-1');
  });

  it('retries once on a fresh session when the server forgot the pooled one', async () => {
    await client.readOnly(async () => undefined);
    sessions[0]?.newTx.mockRejectedValueOnce(grpcError('no session found'));
    await expect(client.readOnly(async () => 'again')).resolves.toBe('again');
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('pins a signing key only when it was given one (the ledger re-anchor asks before trusting a state)', () => {
    const pool = new ImmudbSessionPool(async () => newSession() as unknown as ImmudbSession, 1, 1);
    expect(client.pinsSigningKey()).toBe(false);
    expect(new GrpcImmudbClient(pool, {}).pinsSigningKey()).toBe(false);
    expect(new GrpcImmudbClient(pool, { serverSigningPublicKeyPem: 'PEM' }).pinsSigningKey()).toBe(
      true,
    );
  });
});
