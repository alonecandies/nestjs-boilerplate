import { ImmudbError, isSessionGone, toImmudbError } from '../errors/immudb.error.js';
import { type ImmutableState, TxMode } from '../generated/immudb/schema/schema.pb.js';
import type { ImmudbParams, ImmudbState, ImmudbTx, ImmudbValue } from '../immudb.types.js';
import { equalBytes } from '../verification/bytes.js';
import { fromProtoDualProof, verifyDualProof } from '../verification/dual-proof.js';
import { verifySqlEntry } from '../verification/sql-row.js';
import { verifyStateSignature } from '../verification/state-signature.js';
import { ImmudbClient } from './immudb.client.js';
import type { ImmudbSession } from './immudb-session.js';
import type { ImmudbSessionPool } from './session-pool.js';

async function mapped<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw toImmudbError(error) ?? error;
  }
}

/**
 * immudb 1.11.2 answers a missing primary key (never inserted, or removed by SQL `DELETE`) with
 * `tbtree: key not found` and a missing table with `table does not exist`, both as gRPC UNKNOWN. For a
 * row the caller expects to exist, either one is a failed verification, not a transport error.
 */
const ROW_MISSING = /key not found|table does not exist/;

function rowLookupError(error: unknown, table: string): unknown {
  const known = toImmudbError(error);
  if (known !== undefined) return known;
  const message = error instanceof Error ? error.message : String(error);
  if (!ROW_MISSING.test(message)) return error;
  return new ImmudbError('verification-failed', `no row to verify in ${table}: ${message}`, {
    cause: error,
  });
}

export function toImmudbState(state: ImmutableState): ImmudbState {
  const signature = state.signature?.signature;
  return {
    database: state.db,
    txId: BigInt(state.txId),
    txHash: new Uint8Array(state.txHash),
    signature: signature !== undefined && signature.length > 0 ? new Uint8Array(signature) : null,
  };
}

/** The pooled session was dropped by the server before the transaction began: safe to retry. */
class StaleSessionError extends ImmudbError {
  constructor(cause: unknown) {
    super('unavailable', 'immudb session expired before the transaction began', { cause });
  }
}

class SessionTx implements ImmudbTx {
  wrote = false;
  /** A statement failed: the server already ended the transaction (never Rollback it). */
  failed = false;

  constructor(
    private readonly session: ImmudbSession,
    private readonly id: string,
  ) {}

  async exec(sql: string, params?: ImmudbParams): Promise<void> {
    this.wrote = true;
    await this.guard(this.session.txExec(this.id, sql, params));
  }

  async query<T extends Record<string, ImmudbValue>>(
    sql: string,
    params?: ImmudbParams,
  ): Promise<T[]> {
    return (await this.guard(this.session.txQuery(this.id, sql, params))) as T[];
  }

  private async guard<R>(call: Promise<R>): Promise<R> {
    try {
      return await call;
    } catch (error) {
      this.failed = true;
      throw toImmudbError(error) ?? error;
    }
  }
}

export class GrpcImmudbClient extends ImmudbClient {
  constructor(
    private readonly pool: ImmudbSessionPool,
    private readonly options: { serverSigningPublicKeyPem?: string } = {},
  ) {
    super();
  }

  override readWrite<T>(
    work: (tx: ImmudbTx) => Promise<T>,
  ): Promise<{ result: T; txId: bigint | null }> {
    return this.inTx(TxMode.ReadWrite, undefined, async (session, id) => {
      const tx = new SessionTx(session, id);
      const result = await this.run(session, id, tx, work);
      if (!tx.wrote) {
        await mapped(session.rollback(id));
        return { result, txId: null };
      }
      const committed = await mapped(session.commit(id));
      return { result, txId: BigInt(committed.header?.id ?? '0') };
    });
  }

  override readOnly<T>(
    work: (tx: ImmudbTx) => Promise<T>,
    opts: { mustIncludeTxId?: bigint } = {},
  ): Promise<T> {
    return this.inTx(TxMode.ReadOnly, opts.mustIncludeTxId, async (session, id) => {
      const tx = new SessionTx(session, id);
      const result = await this.run(session, id, tx, work);
      await mapped(session.rollback(id));
      return result;
    });
  }

  override pinsSigningKey(): boolean {
    return this.options.serverSigningPublicKeyPem !== undefined;
  }

  override currentState(): Promise<ImmudbState> {
    return this.pool.use(async (session) => toImmudbState(await mapped(session.currentState())));
  }

  override async verifyConsistency(trusted: ImmudbState, target: ImmudbState): Promise<void> {
    const failed = (message: string): never => {
      throw new ImmudbError('verification-failed', message);
    };
    if (trusted.database !== target.database) failed('states of different databases');
    if (trusted.txId > target.txId) {
      failed(`trusted tx ${trusted.txId} is newer than target tx ${target.txId}`);
    }
    const key = this.options.serverSigningPublicKeyPem;
    if (key !== undefined && !verifyStateSignature(target, key)) {
      failed(`state signature of tx ${target.txId} does not verify`);
    }
    if (trusted.txId === 0n) return;
    if (trusted.txId === target.txId) {
      if (!equalBytes(trusted.txHash, target.txHash)) failed(`tx ${target.txId} hash changed`);
      return;
    }
    const proven = await this.pool.use((session) =>
      mapped(session.verifiableTxById(target.txId, trusted.txId)),
    );
    const proof = fromProtoDualProof(proven.dualProof);
    if (!verifyDualProof(proof, trusted.txId, target.txId, trusted.txHash, target.txHash)) {
      failed(`no valid consistency proof from tx ${trusted.txId} to tx ${target.txId}`);
    }
  }

  override async verifiedRow(
    table: string,
    pk: readonly ImmudbValue[],
    trusted: ImmudbState,
  ): Promise<{ row: Record<string, ImmudbValue>; txId: bigint; state: ImmudbState }> {
    // A trusted state the server has not reached means a rolled-back or forked server: fail closed
    // as verification (the server itself would answer with an unmapped "lower than" error).
    const current = await this.currentState();
    if (trusted.txId > current.txId) {
      throw new ImmudbError(
        'verification-failed',
        `trusted tx ${trusted.txId} is ahead of the server (tx ${current.txId})`,
      );
    }
    const entry = await this.pool.use(async (session) => {
      try {
        return await session.verifiableSqlGet(table, pk, trusted.txId);
      } catch (error) {
        throw rowLookupError(error, table);
      }
    });
    const key = this.options.serverSigningPublicKeyPem;
    return verifySqlEntry(
      entry,
      pk,
      trusted,
      key === undefined ? undefined : (state) => verifyStateSignature(state, key),
    );
  }

  private async run<T>(
    session: ImmudbSession,
    id: string,
    tx: SessionTx,
    work: (tx: ImmudbTx) => Promise<T>,
  ): Promise<T> {
    try {
      return await work(tx);
    } catch (error) {
      // An application error leaves the server tx open: end it. After a failed statement the
      // server already ended it, and Rollback would answer "no transaction found".
      if (!tx.failed) await session.rollback(id).catch(() => undefined);
      throw error;
    }
  }

  private async inTx<T>(
    mode: TxMode,
    mustIncludeTxId: bigint | undefined,
    body: (session: ImmudbSession, id: string) => Promise<T>,
  ): Promise<T> {
    const attempt = (): Promise<T> =>
      this.pool.use(async (session) => {
        let id: string;
        try {
          id = await session.newTx(mode, mustIncludeTxId);
        } catch (error) {
          throw isSessionGone(error)
            ? new StaleSessionError(error)
            : (toImmudbError(error) ?? error);
        }
        return body(session, id);
      });
    try {
      return await attempt();
    } catch (error) {
      if (error instanceof StaleSessionError) return attempt();
      throw error;
    }
  }
}
