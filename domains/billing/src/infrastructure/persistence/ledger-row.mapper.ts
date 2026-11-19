import type {
  LedgerAccountRef,
  LedgerEntryRef,
} from '../../application/repositories/ledger-receipts.repository.js';
import type { LedgerEntryKind } from '../../domain/ledger/ledger.types.js';
import {
  type LedgerDiscrepancyInput,
  ledgerDiscrepancyId,
} from '../../domain/ledger/ledger-discrepancy.js';
import type { ledgerAccounts, ledgerDiscrepancies, ledgerEntryRefs } from './billing.schema.js';

/** The rows the two ledger repositories insert (runtime and system): one mapping for both. */

export function toLedgerEntryRefRow(ref: LedgerEntryRef): typeof ledgerEntryRefs.$inferInsert {
  return {
    tenantId: ref.tenantId,
    entryId: ref.entryId,
    sourceKey: ref.sourceKey,
    payloadHash: ref.payloadHash,
    immudbTxId: ref.immudbTxId,
    paymentId: ref.paymentId,
    kind: ref.kind,
    postedAt: ref.postedAt,
  };
}

export function fromLedgerEntryRefRow(
  row: Omit<typeof ledgerEntryRefs.$inferSelect, 'createdAt'>,
): LedgerEntryRef {
  return {
    tenantId: row.tenantId,
    entryId: row.entryId,
    sourceKey: row.sourceKey,
    payloadHash: row.payloadHash,
    immudbTxId: row.immudbTxId,
    paymentId: row.paymentId,
    // Written only from LedgerEntryRef (the column is text, the type closed).
    kind: row.kind as LedgerEntryKind,
    postedAt: row.postedAt,
  };
}

export function toLedgerAccountRow(account: LedgerAccountRef): typeof ledgerAccounts.$inferInsert {
  return {
    tenantId: account.tenantId,
    code: account.code,
    currency: account.currency,
    immudbAccountId: account.immudbAccountId,
  };
}

/** The id is `ledgerDiscrepancyId`; a new finding never resolves another (`resolves_id` NULL). */
export function toLedgerDiscrepancyRow(
  row: LedgerDiscrepancyInput,
): typeof ledgerDiscrepancies.$inferInsert {
  return {
    tenantId: row.tenantId,
    id: ledgerDiscrepancyId(row),
    kind: row.kind,
    sourceKey: row.sourceKey,
    expected: row.expected,
    actual: row.actual,
    detectedBy: row.detectedBy,
    runId: row.runId,
    resolvesId: null,
  };
}
