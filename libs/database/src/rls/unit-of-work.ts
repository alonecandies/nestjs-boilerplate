import { Propagation } from '@nestjs-cls/transactional';
import type {
  DrizzleSchema,
  DrizzleTransaction,
  DrizzleTransactionHost,
} from '../drizzle/drizzle.types.js';
import { appliedRlsContextOf, assertRlsContextCurrent } from './rls-context.js';

/**
 * The only way a runtime repository reaches the database: `work` runs in the open transaction
 * (`Propagation.Required`) or in a new one, whose BEGIN the transactional adapter follows with the
 * RLS context of the CLS principal (no principal: RLS_NO_PRINCIPAL, nothing sent). Every call
 * compares the CLS principal with what BEGIN applied and throws RLS_CONTEXT_STALE, without
 * running `work`, when they differ (e.g. a `runWithPrincipal(other, …)` inside the transaction):
 * the principal is final before a unit of work opens.
 */
export function inUnitOfWork<TSchema extends DrizzleSchema, T>(
  txHost: DrizzleTransactionHost<TSchema>,
  work: (tx: DrizzleTransaction<TSchema>) => Promise<T>,
): Promise<T> {
  return txHost.withTransaction(Propagation.Required, async () => {
    const tx = txHost.tx;
    assertRlsContextCurrent(appliedRlsContextOf(tx));
    // Inside withTransaction the host always holds the transaction, never the plain pool.
    return work(tx as unknown as DrizzleTransaction<TSchema>);
  });
}
