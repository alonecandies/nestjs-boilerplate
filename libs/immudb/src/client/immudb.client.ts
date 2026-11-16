import type { ImmudbState, ImmudbTx } from '../immudb.types.js';

/** The immudb SQL client every consumer injects (DI token: this class). */
export abstract class ImmudbClient {
  /** Commits when work ran an exec, rolls back otherwise; never rolls back after a failed statement. */
  abstract readWrite<T>(
    work: (tx: ImmudbTx) => Promise<T>,
  ): Promise<{ result: T; txId: bigint | null }>;

  /** Snapshot read; `mustIncludeTxId` waits until that tx is visible (read-your-writes). */
  abstract readOnly<T>(
    work: (tx: ImmudbTx) => Promise<T>,
    opts?: { mustIncludeTxId?: bigint },
  ): Promise<T>;

  abstract currentState(): Promise<ImmudbState>;
}
