import { isPlatformTenantId } from '@platform/common';
import {
  LEDGER_CHART,
  type LedgerAccountCode,
  type LedgerEntryKind,
} from '../../domain/ledger/ledger.types.js';
import type { LedgerDiscrepancyInput } from '../../domain/ledger/ledger-discrepancy.js';

/**
 * The Postgres receipt of one immudb entry (`billing.ledger_entry_refs`): what reconciliation and
 * R5 read instead of immudb. `immudbTxId` is null for a `replayed` outcome.
 */
export interface LedgerEntryRef {
  readonly tenantId: string;
  readonly entryId: string;
  readonly sourceKey: string;
  readonly payloadHash: string;
  readonly immudbTxId: bigint | null;
  readonly paymentId: string | null;
  readonly kind: LedgerEntryKind;
  readonly postedAt: Date;
}

/** The immudb account id of one `(owner tenant, code, currency)` (`billing.ledger_accounts`). */
export interface LedgerAccountRef {
  readonly tenantId: string;
  readonly code: LedgerAccountCode;
  readonly currency: string;
  readonly immudbAccountId: string;
}

/**
 * The ledger receipts as the principal (the posting consumer's `{ userId, tenantId, roles: [] }`),
 * on the runtime pool under the insert-only RLS of 0005: each call is one plain
 * `INSERT … ON CONFLICT DO NOTHING` (no conflict target, no `RETURNING`: the role cannot read the
 * rows unelevated) in the open unit of work or its own. A row of another tenant or of the platform
 * is refused by the policy (`42501`); without a principal nothing is sent (`RLS_NO_PRINCIPAL`).
 * Platform rows and principal-less postings go through `LedgerSystemRepository`.
 */
export abstract class LedgerReceiptsRepository {
  /** `false` when the entry is already recorded under that tenant (the first ref stays). */
  abstract recordEntryRef(ref: LedgerEntryRef): Promise<boolean>;

  /**
   * Records the tenant-owned account rows; rows already there are skipped.
   * @throws Error before any SQL when a row is platform-owned (`assertTenantOwnedAccounts`)
   */
  abstract recordAccounts(rows: readonly LedgerAccountRef[]): Promise<void>;

  /** `false` when the identical finding (`ledgerDiscrepancyId`) is already stored. */
  abstract appendDiscrepancy(row: LedgerDiscrepancyInput): Promise<boolean>;
}

/**
 * The runtime door's rule for account rows: the owner is a tenant and the chart says the code is
 * tenant-owned. A platform-owned row (the platform tenant, or a platform code such as
 * `asset:stripe_balance`) belongs to `LedgerSystemRepository.recordPlatformAccounts`.
 * @throws Error naming the first platform-owned row
 */
export function assertTenantOwnedAccounts(rows: readonly LedgerAccountRef[]): void {
  const platformOwned = rows.find(
    (row) => isPlatformTenantId(row.tenantId) || LEDGER_CHART[row.code].owner === 'platform',
  );
  if (platformOwned !== undefined) {
    throw new Error(
      `ledger account ${platformOwned.code}/${platformOwned.currency} is platform-owned: ` +
        'record it through LedgerSystemRepository.recordPlatformAccounts',
    );
  }
}
