import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable } from '@nestjs/common';
import { ImmudbClient, ImmudbError, type ImmudbState } from '@platform/immudb';
import { LedgerPort } from '../../application/ports/ledger.port.js';
import { resolveLedgerAccount } from '../../domain/ledger/ledger.accounts.js';
import { LedgerVerificationFailedException } from '../../domain/ledger/ledger.errors.js';
import {
  ledgerAccountId,
  ledgerEntryId,
  ledgerPayloadHash,
  toEpochMicros,
} from '../../domain/ledger/ledger.ids.js';
import { assertBalanced } from '../../domain/ledger/ledger.invariant.js';
import {
  LEDGER_CHART,
  type LedgerBalance,
  type LedgerEntry,
  type LedgerEntryDraft,
  type LedgerEntryKind,
  type LedgerImbalance,
  type LedgerPostOutcome,
  type LedgerTrustedState,
} from '../../domain/ledger/ledger.types.js';

const POST_ATTEMPTS = 5;
const SCHEMA_VERSION = 1n;

export const LEDGER_SQL = {
  selectEntryHash: 'SELECT payload_hash FROM ledger_entries WHERE id = @id',
  selectAccount: 'SELECT id FROM ledger_accounts WHERE id = @id',
  insertAccount:
    'INSERT INTO ledger_accounts (id, owner_tenant_id, code, currency, kind, created_at_us) VALUES (@id, @owner_tenant_id, @code, @currency, @kind, @created_at_us)',
  insertEntry:
    'INSERT INTO ledger_entries (id, source_key, tenant_id, kind, payment_id, stripe_object, presentment_amount, presentment_currency, payload_hash, occurred_at_us, recorded_at_us, schema_version) VALUES (@id, @source_key, @tenant_id, @kind, @payment_id, @stripe_object, @presentment_amount, @presentment_currency, @payload_hash, @occurred_at_us, @recorded_at_us, @schema_version)',
  insertPosting:
    'INSERT INTO ledger_postings (id, entry_id, line, tenant_id, account_id, currency, debit, credit) VALUES (@id, @entry_id, @line, @tenant_id, @account_id, @currency, @debit, @credit)',
  entryForTenant:
    'SELECT id, source_key, tenant_id, kind, payment_id, stripe_object, presentment_amount, presentment_currency, payload_hash, occurred_at_us, recorded_at_us FROM ledger_entries WHERE id = @id AND tenant_id = @tenant',
  postingsForTenant:
    'SELECT line, account_id, currency, debit, credit FROM ledger_postings WHERE entry_id = @entry_id AND tenant_id = @tenant',
  balancesForTenant:
    'SELECT account_id, currency, SUM(debit) AS debit_total, SUM(credit) AS credit_total FROM ledger_postings WHERE tenant_id = @tenant GROUP BY account_id, currency',
  balancesForTenantCurrency:
    'SELECT account_id, currency, SUM(debit) AS debit_total, SUM(credit) AS credit_total FROM ledger_postings WHERE tenant_id = @tenant AND currency = @currency GROUP BY account_id, currency',
  // Reconciliation reads (cross-tenant, system context in wave 2).
  // R1 reads only the window's entries and their postings (index on entry_id), never every row.
  entriesRecordedIn:
    'SELECT id, tenant_id FROM ledger_entries WHERE recorded_at_us >= @from_us AND recorded_at_us < @to_us',
  postingsOfEntry: 'SELECT currency, debit, credit FROM ledger_postings WHERE entry_id = @entry_id',
  totalsByCurrency:
    'SELECT currency, SUM(debit) AS debit_total, SUM(credit) AS credit_total FROM ledger_postings GROUP BY currency',
  entriesHistory: 'SELECT id, _rev FROM (HISTORY OF ledger_entries)',
  postingsHistory: 'SELECT id, _rev FROM (HISTORY OF ledger_postings)',
  accountsHistory: 'SELECT id, _rev FROM (HISTORY OF ledger_accounts)',
} as const;

/** Keys of `LEDGER_SQL` that read tenant data: each must carry `tenant_id = @tenant`. */
export const LEDGER_TENANT_READS: readonly (keyof typeof LEDGER_SQL)[] = [
  'entryForTenant',
  'postingsForTenant',
  'balancesForTenant',
  'balancesForTenantCurrency',
];

type HashRow = { payload_hash: string };
type EntryRow = {
  id: string;
  source_key: string;
  tenant_id: string;
  kind: string;
  payment_id: string;
  stripe_object: string;
  presentment_amount: bigint;
  presentment_currency: string;
  payload_hash: string;
  occurred_at_us: bigint;
  recorded_at_us: bigint;
};
type PostingRow = {
  line: bigint;
  account_id: string;
  currency: string;
  debit: bigint;
  credit: bigint;
};
type SumRow = { account_id: string; currency: string; debit_total: bigint; credit_total: bigint };
type WindowEntryRow = { id: string; tenant_id: string };
type EntryPostingRow = { currency: string; debit: bigint; credit: bigint };
type HistoryRow = { id: string; _rev: bigint };
type Unposted = Exclude<LedgerPostOutcome, { status: 'posted' }> | { status: 'pending' };

const fromMicros = (us: bigint): Date => new Date(Number(us / 1_000n));
const orNull = (value: string): string | null => (value === '' ? null : value);

function retryable(error: unknown): boolean {
  return (
    error instanceof ImmudbError &&
    (error.kind === 'read-conflict' || error.kind === 'duplicate-key')
  );
}

/** `LedgerPort` over immudb (spec 2.5). Tenancy is enforced here: immudb has no RLS. */
@Injectable()
export class ImmudbLedgerAdapter extends LedgerPort {
  constructor(private readonly immudb: ImmudbClient) {
    super();
  }

  override async post(draft: LedgerEntryDraft): Promise<LedgerPostOutcome> {
    assertBalanced(draft);
    const entryId = ledgerEntryId(draft.sourceKey);
    const payloadHash = ledgerPayloadHash(draft);
    let lastError: unknown;
    for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt++) {
      try {
        return await this.postOnce(draft, entryId, payloadHash);
      } catch (error) {
        if (!retryable(error)) throw error;
        lastError = error;
        await sleep(Math.floor(Math.random() * 20 * attempt));
      }
    }
    throw lastError;
  }

  private async postOnce(
    draft: LedgerEntryDraft,
    entryId: string,
    payloadHash: string,
  ): Promise<LedgerPostOutcome> {
    const { result, txId } = await this.immudb.readWrite(async (tx): Promise<Unposted> => {
      const [existing] = await tx.query<HashRow>(LEDGER_SQL.selectEntryHash, { id: entryId });
      if (existing !== undefined) {
        return existing.payload_hash === payloadHash
          ? { status: 'replayed', entryId, payloadHash }
          : {
              status: 'conflict',
              entryId,
              payloadHash,
              existingPayloadHash: existing.payload_hash,
            };
      }
      const now = toEpochMicros(new Date());
      const accounts = new Map(
        draft.lines.map((line) => [
          ledgerAccountId(line.accountOwnerTenantId, line.account, line.currency),
          line,
        ]),
      );
      for (const [id, line] of accounts) {
        const [known] = await tx.query(LEDGER_SQL.selectAccount, { id });
        if (known !== undefined) continue;
        await tx.exec(LEDGER_SQL.insertAccount, {
          id,
          owner_tenant_id: line.accountOwnerTenantId,
          code: line.account,
          currency: line.currency,
          kind: LEDGER_CHART[line.account].kind,
          created_at_us: now,
        });
      }
      await tx.exec(LEDGER_SQL.insertEntry, {
        id: entryId,
        source_key: draft.sourceKey,
        tenant_id: draft.tenantId,
        kind: draft.kind,
        payment_id: draft.paymentId ?? '',
        stripe_object: draft.stripeObjectId ?? '',
        presentment_amount: draft.presentment?.amount ?? 0n,
        presentment_currency: draft.presentment?.currency ?? '',
        payload_hash: payloadHash,
        occurred_at_us: toEpochMicros(draft.occurredAt),
        recorded_at_us: now,
        schema_version: SCHEMA_VERSION,
      });
      for (const [i, line] of draft.lines.entries()) {
        await tx.exec(LEDGER_SQL.insertPosting, {
          id: `${entryId}:${i + 1}`,
          entry_id: entryId,
          line: BigInt(i + 1),
          tenant_id: draft.tenantId,
          account_id: ledgerAccountId(line.accountOwnerTenantId, line.account, line.currency),
          currency: line.currency,
          debit: line.debit,
          credit: line.credit,
        });
      }
      return { status: 'pending' };
    });
    if (result.status !== 'pending') return result;
    if (txId === null) throw new Error(`immudb committed ledger entry ${entryId} without a tx id`);
    return { status: 'posted', entryId, payloadHash, immudbTxId: txId };
  }

  override getEntry(tenantId: string, entryId: string): Promise<LedgerEntry | null> {
    return this.immudb.readOnly(async (tx) => {
      const [row] = await tx.query<EntryRow>(LEDGER_SQL.entryForTenant, {
        id: entryId,
        tenant: tenantId,
      });
      if (row === undefined) return null;
      const postings = await tx.query<PostingRow>(LEDGER_SQL.postingsForTenant, {
        entry_id: entryId,
        tenant: tenantId,
      });
      return {
        id: row.id,
        sourceKey: row.source_key,
        tenantId: row.tenant_id,
        kind: row.kind as LedgerEntryKind,
        paymentId: orNull(row.payment_id),
        stripeObjectId: orNull(row.stripe_object),
        presentment:
          row.presentment_currency === ''
            ? null
            : { amount: row.presentment_amount, currency: row.presentment_currency },
        payloadHash: row.payload_hash,
        occurredAt: fromMicros(row.occurred_at_us),
        recordedAt: fromMicros(row.recorded_at_us),
        postings: postings
          .map((p) => ({
            line: Number(p.line),
            accountId: p.account_id,
            currency: p.currency,
            debit: p.debit,
            credit: p.credit,
          }))
          .sort((a, b) => a.line - b.line),
      };
    });
  }

  override balances(tenantId: string, currency?: string): Promise<readonly LedgerBalance[]> {
    return this.immudb.readOnly(async (tx) => {
      const rows =
        currency === undefined
          ? await tx.query<SumRow>(LEDGER_SQL.balancesForTenant, { tenant: tenantId })
          : await tx.query<SumRow>(LEDGER_SQL.balancesForTenantCurrency, {
              tenant: tenantId,
              currency,
            });
      return rows.map((row) => ({
        accountId: row.account_id,
        account: resolveLedgerAccount(row.account_id, tenantId, row.currency),
        currency: row.currency,
        debit: row.debit_total,
        credit: row.credit_total,
      }));
    });
  }

  /**
   * R1 over the entries recorded in `[fromUs, toUs)`: one read of their ids and tenants, then the
   * postings of each by `entry_id` (indexed), summed per currency here. Bounded by the window: no
   * statement aggregates the whole ledger.
   */
  override findUnbalanced(window: {
    fromUs: bigint;
    toUs: bigint;
  }): Promise<readonly LedgerImbalance[]> {
    return this.immudb.readOnly(async (tx) => {
      const inWindow = await tx.query<WindowEntryRow>(LEDGER_SQL.entriesRecordedIn, {
        from_us: window.fromUs,
        to_us: window.toUs,
      });
      const found: LedgerImbalance[] = [];
      for (const { id, tenant_id: tenantId } of inWindow) {
        const postings = await tx.query<EntryPostingRow>(LEDGER_SQL.postingsOfEntry, {
          entry_id: id,
        });
        if (postings.length < 2) {
          found.push({
            entryId: id,
            tenantId,
            currency: null,
            debit: 0n,
            credit: 0n,
            postings: postings.length,
          });
          continue;
        }
        const sums = new Map<string, { debit: bigint; credit: bigint; postings: number }>();
        for (const row of postings) {
          const sum = sums.get(row.currency) ?? { debit: 0n, credit: 0n, postings: 0 };
          sums.set(row.currency, {
            debit: sum.debit + row.debit,
            credit: sum.credit + row.credit,
            postings: sum.postings + 1,
          });
        }
        for (const [currency, sum] of sums) {
          if (sum.debit !== sum.credit) found.push({ entryId: id, tenantId, currency, ...sum });
        }
      }
      return found;
    });
  }

  override totalsByCurrency(): Promise<
    readonly { currency: string; debit: bigint; credit: bigint }[]
  > {
    return this.immudb.readOnly(async (tx) =>
      (
        await tx.query<{ currency: string; debit_total: bigint; credit_total: bigint }>(
          LEDGER_SQL.totalsByCurrency,
        )
      )
        .map((row) => ({
          currency: row.currency,
          debit: row.debit_total,
          credit: row.credit_total,
        }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
    );
  }

  /** Any row with a revision > 1 was updated or deleted: impossible for the INSERT-only user. */
  override findMutations(): Promise<readonly { table: string; id: string; rev: bigint }[]> {
    return this.immudb.readOnly(async (tx) => {
      const found: { table: string; id: string; rev: bigint }[] = [];
      for (const [table, sql] of [
        ['ledger_entries', LEDGER_SQL.entriesHistory],
        ['ledger_postings', LEDGER_SQL.postingsHistory],
        ['ledger_accounts', LEDGER_SQL.accountsHistory],
      ] as const) {
        for (const row of await tx.query<HistoryRow>(sql)) {
          if (row._rev > 1n) found.push({ table, id: row.id, rev: row._rev });
        }
      }
      return found;
    });
  }

  override async verifyEntry(
    entryId: string,
    expectedPayloadHash: string,
    trusted: LedgerTrustedState,
  ): Promise<void> {
    let row: Record<string, unknown>;
    try {
      ({ row } = await this.immudb.verifiedRow(
        'ledger_entries',
        [entryId],
        toImmudbState(trusted),
      ));
    } catch (error) {
      if (error instanceof ImmudbError && error.kind === 'verification-failed') {
        throw new LedgerVerificationFailedException(entryId, error.message, error);
      }
      throw error;
    }
    if (row['payload_hash'] !== expectedPayloadHash) {
      throw new LedgerVerificationFailedException(
        entryId,
        'payload hash differs from the posted one',
      );
    }
  }

  override async advanceTrustedState(
    trusted: LedgerTrustedState | null,
  ): Promise<LedgerTrustedState> {
    const state = await this.immudb.currentState();
    if (trusted !== null) {
      try {
        await this.immudb.verifyConsistency(toImmudbState(trusted), state);
      } catch (error) {
        if (error instanceof ImmudbError && error.kind === 'verification-failed') {
          throw new LedgerVerificationFailedException('trusted-state', error.message, error);
        }
        throw error;
      }
    }
    return { database: state.database, txId: state.txId, txHash: state.txHash };
  }
}

function toImmudbState(trusted: LedgerTrustedState): ImmudbState {
  return { ...trusted, signature: null };
}
