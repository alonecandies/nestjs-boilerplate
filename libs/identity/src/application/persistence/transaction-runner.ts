/**
 * Unit-of-work port: the application layer asks for atomicity without knowing the database.
 * The infrastructure binding (`DrizzleTransactionRunner`) uses @nestjs-cls/transactional's
 * `TransactionHost`, so repositories called inside `work` transparently join the transaction
 * (they read `txHost.tx`) — no transaction object is threaded through signatures.
 */
export abstract class TransactionRunner {
  /** Runs `work` in one transaction (joining an active one); rolls back when it throws. */
  abstract run<T>(work: () => Promise<T>): Promise<T>;
}
