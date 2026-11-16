import { ImmudbError, isSessionGone, toImmudbError } from '../errors/immudb.error.js';
import { type ImmutableState, TxMode } from '../generated/immudb/schema/schema.pb.js';
import type { ImmudbParams, ImmudbState, ImmudbTx, ImmudbValue } from '../immudb.types.js';
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
  constructor(private readonly pool: ImmudbSessionPool) {
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

  override currentState(): Promise<ImmudbState> {
    return this.pool.use(async (session) => toImmudbState(await mapped(session.currentState())));
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
