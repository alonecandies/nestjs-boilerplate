import { getPrincipal, SystemContext } from '@platform/common';
import { RlsContextError, SystemDatabaseError } from '@platform/database';
import type { OutboxRecord } from '@platform/outbox';
import type { InMemoryOutbox } from '@platform/outbox/testing';
import {
  assertLedgerListLimit,
  assertOutboxRecords,
  assertPaymentKeys,
  assertPlatformAccounts,
  assertTrustedStateAdvance,
  type LedgerCursor,
  type LedgerPaymentRow,
  type LedgerRunCounts,
  LedgerSystemRepository,
  PAID_PAYMENT_STATUSES,
  type PaidPaymentRow,
  type StoredTrustedState,
} from '../application/repositories/ledger.system-repository.js';
import {
  assertTenantOwnedAccounts,
  type LedgerAccountRef,
  type LedgerEntryRef,
  LedgerReceiptsRepository,
} from '../application/repositories/ledger-receipts.repository.js';
import type { LedgerTrustedState } from '../domain/ledger/ledger.types.js';
import {
  type LedgerDiscrepancyInput,
  ledgerDiscrepancyId,
} from '../domain/ledger/ledger-discrepancy.js';
import { createInMemoryBillingOutbox } from './in-memory-billing-outbox.js';

/** A stored finding: the input plus its deterministic id. */
export interface InMemoryLedgerDiscrepancy extends LedgerDiscrepancyInput {
  readonly id: string;
}

/** A stored reconciliation run. */
export interface InMemoryLedgerRun {
  readonly id: string;
  readonly from: Date;
  readonly to: Date;
  status: 'running' | 'succeeded' | 'failed';
  counts: LedgerRunCounts;
  finishedAt: Date | null;
}

export interface InMemoryLedgerStoreOptions {
  /** Where `enqueueMissingPostings` writes. Default: a new `createInMemoryBillingOutbox()`. */
  readonly outbox?: InMemoryOutbox;
  /** `verified_at`, `finished_at` and outbox `created_at` stamps. Default: the wall clock. */
  readonly now?: () => Date;
}

/**
 * The ledger's Postgres side in memory, for unit and flow tests: `receipts` is the runtime
 * `LedgerReceiptsRepository`, `system` the `LedgerSystemRepository`, both over the same rows, with
 * the refusals of the real ones:
 * - receipts: no principal → `RLS_NO_PRINCIPAL`; a row of another tenant than the principal's
 *   (the platform's included) → an error with `code: '42501'`, like the insert policy;
 *   `recordAccounts` refuses platform-owned rows before writing;
 * - system: outside `SystemContext` → `SYSTEM_CONTEXT_REQUIRED`; the same pre-SQL checks as
 *   `DrizzleLedgerSystemRepository`; `enqueueMissingPostings` writes into `outbox` (relay it with
 *   the outbox's `pollUnpublished`/`markPublished`).
 * Every insert is idempotent by the table's primary key; refs and findings are never changed.
 * `payments` seeds what `listSucceededPayments` and `findPaymentsByIds` read (`addPayments`).
 */
export class InMemoryLedgerStore {
  readonly entryRefs: LedgerEntryRef[] = [];
  readonly accounts: LedgerAccountRef[] = [];
  readonly discrepancies: InMemoryLedgerDiscrepancy[] = [];
  readonly runs = new Map<string, InMemoryLedgerRun>();
  readonly trustedStates = new Map<string, StoredTrustedState>();
  readonly payments: PaidPaymentRow[] = [];
  readonly outbox: InMemoryOutbox;
  readonly receipts: InMemoryLedgerReceiptsRepository;
  readonly system: InMemoryLedgerSystemRepository;
  readonly now: () => Date;

  constructor(options: InMemoryLedgerStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.outbox = options.outbox ?? createInMemoryBillingOutbox({ now: this.now });
    this.receipts = new InMemoryLedgerReceiptsRepository(this);
    this.system = new InMemoryLedgerSystemRepository(this);
  }

  /** Seeds payments for `listSucceededPayments` (any status; the list filters like the SQL). */
  addPayments(...rows: PaidPaymentRow[]): void {
    this.payments.push(...rows);
  }

  /** Inserts a ref unless `(tenantId, entryId)` exists; `true` when it was new. */
  insertEntryRef(ref: LedgerEntryRef): boolean {
    if (this.entryRefs.some((r) => r.tenantId === ref.tenantId && r.entryId === ref.entryId)) {
      return false;
    }
    this.entryRefs.push({ ...ref });
    return true;
  }

  /** Inserts an account row unless `(tenantId, code, currency)` exists; `true` when it was new. */
  insertAccount(row: LedgerAccountRef): boolean {
    const exists = this.accounts.some(
      (a) => a.tenantId === row.tenantId && a.code === row.code && a.currency === row.currency,
    );
    if (exists) return false;
    this.accounts.push({ ...row });
    return true;
  }

  /** Appends a finding unless its `(tenantId, ledgerDiscrepancyId)` exists; `true` when new. */
  insertDiscrepancy(row: LedgerDiscrepancyInput): boolean {
    const id = ledgerDiscrepancyId(row);
    if (this.discrepancies.some((d) => d.tenantId === row.tenantId && d.id === id)) return false;
    this.discrepancies.push({ ...row, id });
    return true;
  }
}

/** `LedgerReceiptsRepository` over an `InMemoryLedgerStore` (see there). */
export class InMemoryLedgerReceiptsRepository extends LedgerReceiptsRepository {
  constructor(private readonly store: InMemoryLedgerStore) {
    super();
  }

  override async recordEntryRef(ref: LedgerEntryRef): Promise<boolean> {
    requirePrincipalTenant([ref.tenantId]);
    return this.store.insertEntryRef(ref);
  }

  override async recordAccounts(rows: readonly LedgerAccountRef[]): Promise<void> {
    assertTenantOwnedAccounts(rows);
    if (rows.length === 0) return;
    requirePrincipalTenant(rows.map((row) => row.tenantId));
    for (const row of rows) this.store.insertAccount(row);
  }

  override async appendDiscrepancy(row: LedgerDiscrepancyInput): Promise<boolean> {
    requirePrincipalTenant([row.tenantId]);
    return this.store.insertDiscrepancy(row);
  }
}

/** `LedgerSystemRepository` over an `InMemoryLedgerStore` (see there). */
export class InMemoryLedgerSystemRepository extends LedgerSystemRepository {
  constructor(private readonly store: InMemoryLedgerStore) {
    super();
  }

  override async listSucceededPayments(
    from: Date,
    to: Date,
    after: LedgerCursor | null,
    limit: number,
  ): Promise<readonly PaidPaymentRow[]> {
    assertLedgerListLimit(limit);
    requireSystemContext('ledgerReconciliation.listSucceededPayments');
    const rows = this.store.payments.filter(
      (row) => PAID_PAYMENT_STATUSES.includes(row.status) && inWindow(row.paidAt, from, to),
    );
    return page(rows, (row) => row.id, after, limit);
  }

  override async listEntryRefs(
    from: Date,
    to: Date,
    after: LedgerCursor | null,
    limit: number,
  ): Promise<readonly LedgerEntryRef[]> {
    assertLedgerListLimit(limit);
    requireSystemContext('ledgerReconciliation.listEntryRefs');
    const rows = this.store.entryRefs.filter((row) => inWindow(row.postedAt, from, to));
    return page(rows, (row) => row.entryId, after, limit);
  }

  override async findPaymentsByIds(
    keys: readonly LedgerCursor[],
  ): Promise<readonly LedgerPaymentRow[]> {
    assertPaymentKeys(keys);
    if (keys.length === 0) return [];
    requireSystemContext('ledgerReconciliation.findPaymentsByIds');
    return this.store.payments
      .filter((row) => keys.some((key) => key.tenantId === row.tenantId && key.id === row.id))
      .map(({ tenantId, id, userId, status }) => ({ tenantId, id, userId, status }));
  }

  override async appendDiscrepancies(rows: readonly LedgerDiscrepancyInput[]): Promise<number> {
    requireSystemContext('ledgerReconciliation.appendDiscrepancies');
    return rows.filter((row) => this.store.insertDiscrepancy(row)).length;
  }

  override async enqueueMissingPostings(records: readonly OutboxRecord[]): Promise<number> {
    assertOutboxRecords(records);
    requireSystemContext('ledgerReconciliation.enqueueMissingPostings');
    const { records: stored } = this.store.outbox;
    let inserted = 0;
    for (const record of records) {
      if (stored.some((row) => row.tenantId === record.tenantId && row.id === record.id)) continue;
      stored.push({ ...record, createdAt: this.store.now(), publishedAt: null });
      inserted += 1;
    }
    return inserted;
  }

  override async recordEntryRefs(rows: readonly LedgerEntryRef[]): Promise<number> {
    requireSystemContext('ledgerEntryRefs.recordAsSystem');
    return rows.filter((row) => this.store.insertEntryRef(row)).length;
  }

  override async recordPlatformAccounts(rows: readonly LedgerAccountRef[]): Promise<number> {
    assertPlatformAccounts(rows);
    requireSystemContext('ledgerAccounts.recordPlatformAccounts');
    return rows.filter((row) => this.store.insertAccount(row)).length;
  }

  override async readTrustedState(database: string): Promise<StoredTrustedState | null> {
    requireSystemContext('ledgerTrustedState.read');
    const stored = this.store.trustedStates.get(database);
    return stored === undefined
      ? null
      : {
          ...stored,
          txHash: new Uint8Array(stored.txHash),
          verifiedAt: new Date(stored.verifiedAt),
          readAt: stored.readAt === null ? null : new Date(stored.readAt),
        };
  }

  override async advanceTrustedState(
    database: string,
    from: LedgerTrustedState | null,
    to: LedgerTrustedState,
    readAt: Date,
  ): Promise<boolean> {
    assertTrustedStateAdvance(database, from, to);
    requireSystemContext('ledgerTrustedState.advance');
    const stored = this.store.trustedStates.get(database);
    const matches =
      from === null
        ? stored === undefined
        : stored !== undefined &&
          stored.txId === from.txId &&
          sameBytes(stored.txHash, from.txHash);
    if (!matches) return false;
    this.store.trustedStates.set(database, {
      database,
      txId: to.txId,
      txHash: new Uint8Array(to.txHash),
      verifiedAt: this.store.now(),
      readAt: new Date(readAt),
    });
    return true;
  }

  override async startRun(run: {
    readonly id: string;
    readonly from: Date;
    readonly to: Date;
  }): Promise<void> {
    requireSystemContext('ledgerRuns.start');
    if (this.store.runs.has(run.id)) {
      throw Object.assign(new Error(`ledger run ${run.id} exists`), { code: '23505' });
    }
    this.store.runs.set(run.id, {
      id: run.id,
      from: run.from,
      to: run.to,
      status: 'running',
      counts: { found: {}, appended: {} },
      finishedAt: null,
    });
  }

  override async finishRun(
    id: string,
    status: 'succeeded' | 'failed',
    counts: LedgerRunCounts,
  ): Promise<void> {
    requireSystemContext('ledgerRuns.finish');
    const run = this.store.runs.get(id);
    if (run === undefined || run.finishedAt !== null) return;
    run.status = status;
    run.counts = counts;
    run.finishedAt = this.store.now();
  }
}

function inWindow(at: Date, from: Date, to: Date): boolean {
  return at.getTime() >= from.getTime() && at.getTime() < to.getTime();
}

/** Keyset page by `(tenantId, id)` in byte order (lowercase uuids compare like Postgres' uuid). */
function page<T extends { readonly tenantId: string }>(
  rows: readonly T[],
  idOf: (row: T) => string,
  after: LedgerCursor | null,
  limit: number,
): T[] {
  const key = (tenantId: string, id: string) => `${tenantId}/${id}`;
  const start = after === null ? null : key(after.tenantId, after.id);
  return rows
    .map((row) => ({ row, at: key(row.tenantId, idOf(row)) }))
    .filter(({ at }) => start === null || at > start)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .slice(0, limit)
    .map(({ row }) => row);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** The runtime pool's refusals: no principal (before BEGIN), or a row the insert policy rejects. */
function requirePrincipalTenant(tenantIds: readonly string[]): void {
  const principal = getPrincipal();
  if (principal === undefined) {
    throw new RlsContextError('RLS_NO_PRINCIPAL', 'No principal for the unit of work');
  }
  if (tenantIds.some((tenantId) => tenantId !== principal.tenantId)) {
    throw Object.assign(new Error('new row violates row-level security policy'), {
      code: '42501',
    });
  }
}

function requireSystemContext(method: string): void {
  if (!SystemContext.isActive()) {
    throw new SystemDatabaseError(
      'SYSTEM_CONTEXT_REQUIRED',
      `System method ${method} runs only inside SystemContext.run()`,
    );
  }
}
