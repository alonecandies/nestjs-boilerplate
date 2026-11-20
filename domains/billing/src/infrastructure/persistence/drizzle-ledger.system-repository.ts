import { Injectable } from '@nestjs/common';
import { InjectSystemDatabase, SystemDatabase } from '@platform/database';
import type { OutboxRecord } from '@platform/outbox';
import { and, asc, eq, gt, gte, inArray, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { chunk } from 'lodash-es';
import {
  assertLedgerListLimit,
  assertOutboxRecords,
  assertPaymentKeys,
  assertPlatformAccounts,
  assertTrustedStateAdvance,
  type LedgerCursor,
  type LedgerPaymentRow,
  type LedgerRunCounts,
  type LedgerSystemRepository,
  PAID_PAYMENT_STATUSES,
  type PaidPaymentRow,
  type StoredTrustedState,
} from '../../application/repositories/ledger.system-repository.js';
import type {
  LedgerAccountRef,
  LedgerEntryRef,
} from '../../application/repositories/ledger-receipts.repository.js';
import type { LedgerTrustedState } from '../../domain/ledger/ledger.types.js';
import type { LedgerDiscrepancyInput } from '../../domain/ledger/ledger-discrepancy.js';
import {
  type BillingSchema,
  ledgerAccounts,
  ledgerDiscrepancies,
  ledgerEntryRefs,
  ledgerReconciliationRuns,
  ledgerTrustedState,
  outbox,
  payments,
} from './billing.schema.js';
import { BILLING_SYSTEM_METHODS } from './billing.system-methods.js';
import {
  fromLedgerEntryRefRow,
  toLedgerAccountRow,
  toLedgerDiscrepancyRow,
  toLedgerEntryRefRow,
} from './ledger-row.mapper.js';

const {
  ledgerReconciliation: reconciliation,
  ledgerEntryRefs: entryRefs,
  ledgerAccounts: accounts,
  ledgerTrustedState: trustedState,
  ledgerRuns: runs,
} = BILLING_SYSTEM_METHODS;

/** Rows per INSERT statement (far below Postgres' 65 535 bind parameters). */
const INSERT_CHUNK = 500;

/** `(tenant, id) > (after.tenantId, after.id)`, or nothing on the first page. */
function keysetAfter(tenant: PgColumn, id: PgColumn, after: LedgerCursor | null): SQL | undefined {
  if (after === null) return undefined;
  return or(gt(tenant, after.tenantId), and(eq(tenant, after.tenantId), gt(id, after.id)));
}

/**
 * The ledger on the `app_system` (BYPASSRLS) pool, through `SystemDatabase.run` and the pinned
 * methods only (`BILLING_SYSTEM_METHODS`): each call is logged and counted, refused outside
 * `SystemContext`, and its statements commit on their own. `app_system` holds `SELECT, INSERT` on
 * the three tenant ledger tables, `SELECT, INSERT, UPDATE` on the two local ones (0005), the
 * outbox grants (0004) and `SELECT` on `payments` (0006). The lists are multi-shard keyset reads
 * over a half-open window, without row locks; the only UPDATEs touch the two local tables.
 */
@Injectable()
export class DrizzleLedgerSystemRepository implements LedgerSystemRepository {
  constructor(@InjectSystemDatabase() private readonly system: SystemDatabase<BillingSchema>) {}

  async listSucceededPayments(
    from: Date,
    to: Date,
    after: LedgerCursor | null,
    limit: number,
  ): Promise<readonly PaidPaymentRow[]> {
    assertLedgerListLimit(limit);
    return this.system.run(reconciliation.listSucceededPayments, async (db) => {
      const rows = await db
        .select({
          tenantId: payments.tenantId,
          id: payments.id,
          userId: payments.userId,
          status: payments.status,
          amountTotal: payments.amountTotal,
          currency: payments.currency,
          paidAt: payments.paidAt,
        })
        .from(payments)
        .where(
          and(
            inArray(payments.status, [...PAID_PAYMENT_STATUSES]),
            gte(payments.paidAt, from),
            lt(payments.paidAt, to),
            keysetAfter(payments.tenantId, payments.id, after),
          ),
        )
        .orderBy(asc(payments.tenantId), asc(payments.id))
        .limit(limit);
      return rows.map(
        (row): PaidPaymentRow => ({
          tenantId: row.tenantId,
          id: row.id,
          userId: row.userId,
          status: row.status,
          amountTotal: row.amountTotal === null ? null : BigInt(row.amountTotal),
          currency: row.currency,
          // `paid_at >= from` excludes NULL: every listed payment was paid.
          paidAt: row.paidAt as Date,
        }),
      );
    });
  }

  async listEntryRefs(
    from: Date,
    to: Date,
    after: LedgerCursor | null,
    limit: number,
  ): Promise<readonly LedgerEntryRef[]> {
    assertLedgerListLimit(limit);
    return this.system.run(reconciliation.listEntryRefs, async (db) => {
      const rows = await db
        .select({
          tenantId: ledgerEntryRefs.tenantId,
          entryId: ledgerEntryRefs.entryId,
          sourceKey: ledgerEntryRefs.sourceKey,
          payloadHash: ledgerEntryRefs.payloadHash,
          immudbTxId: ledgerEntryRefs.immudbTxId,
          paymentId: ledgerEntryRefs.paymentId,
          kind: ledgerEntryRefs.kind,
          postedAt: ledgerEntryRefs.postedAt,
        })
        .from(ledgerEntryRefs)
        .where(
          and(
            gte(ledgerEntryRefs.postedAt, from),
            lt(ledgerEntryRefs.postedAt, to),
            keysetAfter(ledgerEntryRefs.tenantId, ledgerEntryRefs.entryId, after),
          ),
        )
        .orderBy(asc(ledgerEntryRefs.tenantId), asc(ledgerEntryRefs.entryId))
        .limit(limit);
      return rows.map(fromLedgerEntryRefRow);
    });
  }

  async findPaymentsByIds(keys: readonly LedgerCursor[]): Promise<readonly LedgerPaymentRow[]> {
    assertPaymentKeys(keys);
    if (keys.length === 0) return [];
    const wanted = new Set(keys.map((key) => `${key.tenantId}/${key.id}`));
    // ONE array parameter per column, not `IN ($1…$n)`: the SQL text is the same for every batch
    // size. The pairs are matched exactly below (the arrays alone also admit cross pairs).
    const tenants = [...new Set(keys.map((key) => key.tenantId))];
    const ids = [...new Set(keys.map((key) => key.id))];
    const rows = await this.system.run(reconciliation.findPaymentsByIds, (db) =>
      db
        .select({
          tenantId: payments.tenantId,
          id: payments.id,
          userId: payments.userId,
          status: payments.status,
        })
        .from(payments)
        .where(
          and(
            sql`${payments.tenantId} = any(${sql.param(tenants)}::uuid[])`,
            sql`${payments.id} = any(${sql.param(ids)}::uuid[])`,
          ),
        ),
    );
    return rows.filter((row) => wanted.has(`${row.tenantId}/${row.id}`));
  }

  appendDiscrepancies(rows: readonly LedgerDiscrepancyInput[]): Promise<number> {
    return this.system.run(reconciliation.appendDiscrepancies, async (db) => {
      let inserted = 0;
      for (const batch of chunk(rows.map(toLedgerDiscrepancyRow), INSERT_CHUNK)) {
        const stored = await db
          .insert(ledgerDiscrepancies)
          .values(batch)
          .onConflictDoNothing({ target: [ledgerDiscrepancies.tenantId, ledgerDiscrepancies.id] })
          .returning({ id: ledgerDiscrepancies.id });
        inserted += stored.length;
      }
      return inserted;
    });
  }

  async enqueueMissingPostings(records: readonly OutboxRecord[]): Promise<number> {
    assertOutboxRecords(records);
    return this.system.run(reconciliation.enqueueMissingPostings, async (db) => {
      let inserted = 0;
      for (const batch of chunk(records, INSERT_CHUNK)) {
        const stored = await db
          .insert(outbox)
          .values(
            batch.map(({ tenantId, id, topic, key, envelope }) => ({
              tenantId,
              id,
              topic,
              key,
              envelope,
            })),
          )
          .onConflictDoNothing({ target: [outbox.tenantId, outbox.id] })
          .returning({ id: outbox.id });
        inserted += stored.length;
      }
      return inserted;
    });
  }

  recordEntryRefs(rows: readonly LedgerEntryRef[]): Promise<number> {
    return this.system.run(entryRefs.recordAsSystem, async (db) => {
      let inserted = 0;
      for (const batch of chunk(rows.map(toLedgerEntryRefRow), INSERT_CHUNK)) {
        const stored = await db
          .insert(ledgerEntryRefs)
          .values(batch)
          .onConflictDoNothing({ target: [ledgerEntryRefs.tenantId, ledgerEntryRefs.entryId] })
          .returning({ id: ledgerEntryRefs.entryId });
        inserted += stored.length;
      }
      return inserted;
    });
  }

  async recordPlatformAccounts(rows: readonly LedgerAccountRef[]): Promise<number> {
    assertPlatformAccounts(rows);
    return this.system.run(accounts.recordPlatformAccounts, async (db) => {
      let inserted = 0;
      for (const batch of chunk(rows.map(toLedgerAccountRow), INSERT_CHUNK)) {
        const stored = await db
          .insert(ledgerAccounts)
          .values(batch)
          .onConflictDoNothing({
            target: [ledgerAccounts.tenantId, ledgerAccounts.code, ledgerAccounts.currency],
          })
          .returning({ code: ledgerAccounts.code });
        inserted += stored.length;
      }
      return inserted;
    });
  }

  readTrustedState(database: string): Promise<StoredTrustedState | null> {
    return this.system.run(trustedState.read, async (db) => {
      const [row] = await db
        .select({
          database: ledgerTrustedState.database,
          txId: ledgerTrustedState.txId,
          txHash: ledgerTrustedState.txHash,
          verifiedAt: ledgerTrustedState.verifiedAt,
          readAt: ledgerTrustedState.readAt,
        })
        .from(ledgerTrustedState)
        .where(eq(ledgerTrustedState.database, database));
      if (row === undefined) return null;
      // postgres.js parses bytea as a Buffer: hand out a plain Uint8Array copy.
      return { ...row, txHash: new Uint8Array(row.txHash) };
    });
  }

  async advanceTrustedState(
    database: string,
    from: LedgerTrustedState | null,
    to: LedgerTrustedState,
    readAt: Date,
  ): Promise<boolean> {
    assertTrustedStateAdvance(database, from, to);
    return this.system.run(trustedState.advance, async (db) => {
      if (from === null) {
        const stored = await db
          .insert(ledgerTrustedState)
          .values({ database, txId: to.txId, txHash: to.txHash, verifiedAt: sql`now()`, readAt })
          .onConflictDoNothing({ target: ledgerTrustedState.database })
          .returning({ database: ledgerTrustedState.database });
        return stored.length > 0;
      }
      const result = await db
        .update(ledgerTrustedState)
        .set({ txId: to.txId, txHash: to.txHash, verifiedAt: sql`now()`, readAt })
        .where(
          and(
            eq(ledgerTrustedState.database, database),
            eq(ledgerTrustedState.txId, from.txId),
            eq(ledgerTrustedState.txHash, from.txHash),
          ),
        );
      return result.count > 0;
    });
  }

  async startRun(run: {
    readonly id: string;
    readonly from: Date;
    readonly to: Date;
  }): Promise<void> {
    await this.system.run(runs.start, (db) =>
      db.insert(ledgerReconciliationRuns).values({
        id: run.id,
        fromTs: run.from,
        toTs: run.to,
        status: 'running',
        counts: { found: {}, appended: {} } satisfies LedgerRunCounts,
      }),
    );
  }

  async finishRun(
    id: string,
    status: 'succeeded' | 'failed',
    counts: LedgerRunCounts,
  ): Promise<void> {
    await this.system.run(runs.finish, (db) =>
      db
        .update(ledgerReconciliationRuns)
        .set({ status, counts, finishedAt: sql`now()` })
        .where(
          and(eq(ledgerReconciliationRuns.id, id), isNull(ledgerReconciliationRuns.finishedAt)),
        ),
    );
  }
}
