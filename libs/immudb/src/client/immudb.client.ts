import type { ImmudbState, ImmudbTx, ImmudbValue } from '../immudb.types.js';

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

  /** Dual proof from `trusted` to `target` (and the target's signature when a key is pinned). */
  abstract verifyConsistency(trusted: ImmudbState, target: ImmudbState): Promise<void>;

  /**
   * Row by primary key, proven included in a tx consistent with `trusted`. A missing row or table
   * and every failed proof throw `ImmudbError` with kind `verification-failed`. Only the row's key
   * and value bytes are proven, not the table catalog the server labels them with (see
   * `verifySqlEntry`).
   */
  abstract verifiedRow(
    table: string,
    pk: readonly ImmudbValue[],
    trusted: ImmudbState,
  ): Promise<{ row: Record<string, ImmudbValue>; txId: bigint; state: ImmudbState }>;
}
