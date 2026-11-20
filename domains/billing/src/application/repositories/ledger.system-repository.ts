import { isPlatformTenantId } from '@platform/common';
import type { OutboxRecord } from '@platform/outbox';
import type { LedgerTrustedState } from '../../domain/ledger/ledger.types.js';
import type { LedgerDiscrepancyInput } from '../../domain/ledger/ledger-discrepancy.js';
import { PaymentStatus } from '../../domain/payment-status.enum.js';
import type { LedgerAccountRef, LedgerEntryRef } from './ledger-receipts.repository.js';

/** Keyset position of a list: the last row's `(tenant_id, id)` (`entry_id` for refs). */
export interface LedgerCursor {
  readonly tenantId: string;
  readonly id: string;
}

/** A payment reconciliation R3 expects an entry for (minor units; no PII). */
export interface PaidPaymentRow {
  readonly tenantId: string;
  readonly id: string;
  readonly userId: string;
  readonly status: PaymentStatus;
  readonly amountTotal: bigint | null;
  readonly currency: string | null;
  readonly paidAt: Date;
}

/** A payment by key, as `findPaymentsByIds` reads it: its owner and status (no PII). */
export interface LedgerPaymentRow {
  readonly tenantId: string;
  readonly id: string;
  readonly userId: string;
  readonly status: PaymentStatus;
}

/** Findings per kind (`found`) and the new rows among them (`appended`). */
export interface LedgerRunCounts {
  readonly found: Readonly<Record<string, number>>;
  readonly appended: Readonly<Record<string, number>>;
}

/** A stored trusted state (`readTrustedState`). */
export type StoredTrustedState = LedgerTrustedState & {
  /** When the compare-and-set stored it (the database clock). */
  readonly verifiedAt: Date;
  /** When R5 read it, before its proof (R5's clock); null for a state stored before 0008. */
  readonly readAt: Date | null;
};

/** The statuses `listSucceededPayments` returns: every status a paid payment can be in. */
export const PAID_PAYMENT_STATUSES: readonly PaymentStatus[] = Object.freeze([
  PaymentStatus.Succeeded,
  PaymentStatus.Refunded,
  PaymentStatus.PartiallyRefunded,
  PaymentStatus.Disputed,
]);

/** The largest page `listSucceededPayments` and `listEntryRefs` serve, and the most keys of one
 * `findPaymentsByIds` call. */
export const LEDGER_LIST_MAX_LIMIT = 1000;

/**
 * The ledger on the `app_system` pool (spec §9 items 9-11 and plan delta 4; implemented by
 * `DrizzleLedgerSystemRepository`). Every method is one pinned `system`-scope method
 * (`BILLING_SYSTEM_METHODS`, named in each comment): it runs only inside `SystemContext.run(…)`,
 * never joins a runtime transaction, and its statements commit on their own. The lists are
 * multi-shard reads bounded by a half-open window and a keyset page; no method aggregates the
 * ledger or takes a row lock, and none updates or deletes a ref or a discrepancy.
 */
export abstract class LedgerSystemRepository {
  /**
   * `ledgerReconciliation.listSucceededPayments`: the payments of every tenant (the platform's
   * included) with `paid_at` in `[from, to)` and a paid status (`PAID_PAYMENT_STATUSES`), after
   * `after` in `(tenant_id, id)` order, at most `limit` (1..`LEDGER_LIST_MAX_LIMIT`).
   */
  abstract listSucceededPayments(
    from: Date,
    to: Date,
    after: LedgerCursor | null,
    limit: number,
  ): Promise<readonly PaidPaymentRow[]>;

  /**
   * `ledgerReconciliation.listEntryRefs`: the refs of every tenant with `posted_at` in
   * `[from, to)`, after `after` in `(tenant_id, entry_id)` order, at most `limit`.
   */
  abstract listEntryRefs(
    from: Date,
    to: Date,
    after: LedgerCursor | null,
    limit: number,
  ): Promise<readonly LedgerEntryRef[]>;

  /**
   * `ledgerReconciliation.findPaymentsByIds`: the payments of `keys` (any tenant, any status),
   * each matched on both its tenant and its id; a key with no such payment has no row. At most
   * `LEDGER_LIST_MAX_LIMIT` keys; none reads nothing.
   * @throws RangeError before any SQL when there are more keys
   */
  abstract findPaymentsByIds(keys: readonly LedgerCursor[]): Promise<readonly LedgerPaymentRow[]>;

  /**
   * `ledgerReconciliation.appendDiscrepancies`: appends the findings under their tenants, ids by
   * `ledgerDiscrepancyId`; returns how many rows are new (a finding stored before counts 0).
   */
  abstract appendDiscrepancies(rows: readonly LedgerDiscrepancyInput[]): Promise<number>;

  /**
   * `ledgerReconciliation.enqueueMissingPostings`: inserts outbox records of any tenant, the
   * platform's included, into `billing.outbox`; idempotent by `(tenant_id, id)`; returns how many
   * rows are new.
   * @throws Error before any SQL when a record's tenant or id differs from its envelope's
   */
  abstract enqueueMissingPostings(records: readonly OutboxRecord[]): Promise<number>;

  /**
   * `ledgerEntryRefs.recordAsSystem`: the refs of platform or user-less postings, any tenant;
   * idempotent (an existing ref stays); returns how many rows are new.
   */
  abstract recordEntryRefs(rows: readonly LedgerEntryRef[]): Promise<number>;

  /**
   * `ledgerAccounts.recordPlatformAccounts`: account rows owned by `PLATFORM_TENANT_ID`;
   * idempotent; returns how many rows are new.
   * @throws Error before any SQL when a row has another tenant (`assertPlatformAccounts`)
   */
  abstract recordPlatformAccounts(rows: readonly LedgerAccountRef[]): Promise<number>;

  /**
   * `ledgerTrustedState.read`: the stored state of `database`, when it was verified and when R5
   * read it (`null` for a state stored before migration 0008), or null.
   */
  abstract readTrustedState(database: string): Promise<StoredTrustedState | null>;

  /**
   * `ledgerTrustedState.advance`: compare-and-set. With `from = null` it inserts `to` only when
   * `database` has no state yet; otherwise it replaces the state only while it still equals `from`
   * (tx id and hash), stamping `verified_at` and storing `readAt` (when R5 read `to`). `false` when
   * it lost the race or the state is stale.
   * @throws Error before any SQL when `to.txId < from.txId` or a state names another database
   */
  abstract advanceTrustedState(
    database: string,
    from: LedgerTrustedState | null,
    to: LedgerTrustedState,
    readAt: Date,
  ): Promise<boolean>;

  /** `ledgerRuns.start`: records the run as `running` over `[from, to)` with zero counts. */
  abstract startRun(run: {
    readonly id: string;
    readonly from: Date;
    readonly to: Date;
  }): Promise<void>;

  /**
   * `ledgerRuns.finish`: sets the status, counts and `finished_at` of a running run; a finished
   * run is left unchanged.
   */
  abstract finishRun(
    id: string,
    status: 'succeeded' | 'failed',
    counts: LedgerRunCounts,
  ): Promise<void>;
}

/** @throws RangeError when `limit` is not an integer in 1..`LEDGER_LIST_MAX_LIMIT` */
export function assertLedgerListLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_LIST_MAX_LIMIT) {
    throw new RangeError(`ledger list limit must be an integer in 1..${LEDGER_LIST_MAX_LIMIT}`);
  }
}

/** @throws RangeError when there are more than `LEDGER_LIST_MAX_LIMIT` payment keys */
export function assertPaymentKeys(keys: readonly LedgerCursor[]): void {
  if (keys.length > LEDGER_LIST_MAX_LIMIT) {
    throw new RangeError(`at most ${LEDGER_LIST_MAX_LIMIT} payment keys per lookup`);
  }
}

/** @throws Error naming the first row that is not owned by `PLATFORM_TENANT_ID` */
export function assertPlatformAccounts(rows: readonly LedgerAccountRef[]): void {
  const other = rows.find((row) => !isPlatformTenantId(row.tenantId));
  if (other !== undefined) {
    throw new Error(
      `ledger account ${other.code}/${other.currency} is not owned by PLATFORM_TENANT_ID: ` +
        "record a tenant's accounts through LedgerReceiptsRepository.recordAccounts",
    );
  }
}

/** @throws Error when a record's row tenant or id is not its envelope's (`OutboxRecord` rule) */
export function assertOutboxRecords(records: readonly OutboxRecord[]): void {
  const bad = records.find(
    (record) => record.envelope.id !== record.id || record.envelope.tenantId !== record.tenantId,
  );
  if (bad !== undefined) {
    throw new Error(`outbox record ${bad.id}: its tenant and id must be its envelope's`);
  }
}

/** @throws Error when the advance names another database or moves the tx id backwards */
export function assertTrustedStateAdvance(
  database: string,
  from: LedgerTrustedState | null,
  to: LedgerTrustedState,
): void {
  if (to.database !== database || (from !== null && from.database !== database)) {
    throw new Error(`trusted state advance of ${database}: every state must name that database`);
  }
  if (from !== null && to.txId < from.txId) {
    throw new Error(
      `trusted state advance of ${database}: tx id ${to.txId} < ${from.txId} goes backwards`,
    );
  }
}
