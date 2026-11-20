import { Injectable } from '@nestjs/common';
import {
  type DrizzleTransactionalAdapter,
  inUnitOfWork,
  TransactionHost,
} from '@platform/database';
import {
  assertTenantOwnedAccounts,
  type LedgerAccountRef,
  type LedgerEntryRef,
  type LedgerReceiptsRepository,
} from '../../application/repositories/ledger-receipts.repository.js';
import type { LedgerDiscrepancyInput } from '../../domain/ledger/ledger-discrepancy.js';
import {
  type BillingSchema,
  ledgerAccounts,
  ledgerDiscrepancies,
  ledgerEntryRefs,
} from './billing.schema.js';
import {
  toLedgerAccountRow,
  toLedgerDiscrepancyRow,
  toLedgerEntryRefRow,
} from './ledger-row.mapper.js';

/**
 * The ledger receipts as the principal, on the runtime pool under the ledger's insert-only RLS: one
 * `INSERT … ON CONFLICT DO NOTHING` per call, without a conflict target and without `RETURNING`
 * (the form Task 10's probe pinned for a non-elevated `app_runtime` principal on Citus: 1 row,
 * then 0), in the open unit of work or its own (`inUnitOfWork`). The affected-row count tells new
 * from "already there"; the role never reads the rows.
 */
@Injectable()
export class DrizzleLedgerReceiptsRepository implements LedgerReceiptsRepository {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<BillingSchema>>,
  ) {}

  recordEntryRef(ref: LedgerEntryRef): Promise<boolean> {
    return inUnitOfWork(this.txHost, async (tx) => {
      const result = await tx
        .insert(ledgerEntryRefs)
        .values(toLedgerEntryRefRow(ref))
        .onConflictDoNothing();
      return result.count > 0;
    });
  }

  async recordAccounts(rows: readonly LedgerAccountRef[]): Promise<void> {
    assertTenantOwnedAccounts(rows);
    if (rows.length === 0) return;
    await inUnitOfWork(this.txHost, (tx) =>
      tx.insert(ledgerAccounts).values(rows.map(toLedgerAccountRow)).onConflictDoNothing(),
    );
  }

  appendDiscrepancy(row: LedgerDiscrepancyInput): Promise<boolean> {
    return inUnitOfWork(this.txHost, async (tx) => {
      const result = await tx
        .insert(ledgerDiscrepancies)
        .values(toLedgerDiscrepancyRow(row))
        .onConflictDoNothing();
      return result.count > 0;
    });
  }
}
