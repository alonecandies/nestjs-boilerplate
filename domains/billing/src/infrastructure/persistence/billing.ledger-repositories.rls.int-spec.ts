import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAYMENT_SUCCEEDED_EVENT } from '@domain/billing-contracts';
import {
  createPrincipal,
  PLATFORM_TENANT_ID,
  type Principal,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import type { DrizzleTransactionHost } from '@platform/database';
import type { OutboxRecord } from '@platform/outbox';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BillingDatabase, startBillingDatabase } from '../../../test/billing-database.js';
import type {
  LedgerCursor,
  LedgerSystemRepository,
} from '../../application/repositories/ledger.system-repository.js';
import type {
  LedgerAccountRef,
  LedgerEntryRef,
} from '../../application/repositories/ledger-receipts.repository.js';
import { ledgerAccountId } from '../../domain/ledger/ledger.ids.js';
import type { LedgerTrustedState } from '../../domain/ledger/ledger.types.js';
import {
  type LedgerDiscrepancyInput,
  ledgerDiscrepancyId,
} from '../../domain/ledger/ledger-discrepancy.js';
import { PaymentStatus } from '../../domain/payment-status.enum.js';
import { payments } from './billing.schema.js';
import { BILLING_OUTBOX, BillingOutbox } from './billing-outbox.js';
import { DrizzleLedgerSystemRepository } from './drizzle-ledger.system-repository.js';
import { DrizzleLedgerReceiptsRepository } from './drizzle-ledger-receipts.repository.js';
import { BillingOutboxSystemRepository } from './drizzle-outbox.system-repository.js';

/*
 * The ledger repositories (outbox plan Task 11) on the roles of production: the real DatabaseModule
 * on startRlsTestPostgres (Citus 14.2, local execution off), billing's migrations as app_owner, the
 * receipts repository as app_runtime under 0005's insert-only RLS (a non-elevated member, like the
 * posting consumer's `roles: []` principal), the system repository as app_system inside
 * SystemContext. Seeding and assertions go through the superuser.
 * Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project billing:int billing.ledger-repositories.rls
 */

/** A uuid whose last group hex-encodes `suffix` (at most 6 characters), e.g. `id('r1')`. */
const id = (suffix: string): string =>
  `0197c400-0000-7000-8000-${Buffer.from(suffix).toString('hex').padStart(12, '0')}`;
const TENANT_A = id('a0');
const TENANT_B = id('b0');
const A1 = id('1a1');
const B1 = id('1b1');
const a1 = createPrincipal({ userId: A1, tenantId: TENANT_A, roles: ['member'] });
const b1 = createPrincipal({ userId: B1, tenantId: TENANT_B, roles: ['member'] });

const NO_PRINCIPAL = { name: 'RlsContextError', code: 'RLS_NO_PRINCIPAL' };
const SYSTEM_CONTEXT_REQUIRED = { name: 'SystemDatabaseError', code: 'SYSTEM_CONTEXT_REQUIRED' };

/** The SQLSTATE of a failed statement (drizzle wraps the driver error as `cause`). */
async function sqlState(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return 'no error';
  } catch (error) {
    const { cause, code } = error as { cause?: { code?: string }; code?: string };
    return cause?.code ?? code;
  }
}

const ref = (tenantId: string, entry: string, overrides: Partial<LedgerEntryRef> = {}) =>
  ({
    tenantId,
    entryId: entry,
    sourceKey: `stripe:txn:txn_${entry.slice(-4)}`,
    payloadHash: 'a'.repeat(64),
    immudbTxId: 9_007_199_254_740_993n,
    paymentId: null,
    kind: 'charge',
    postedAt: new Date('2026-11-10T10:00:00.000Z'),
    ...overrides,
  }) satisfies LedgerEntryRef;

const account = (
  tenantId: string,
  code: LedgerAccountRef['code'],
  currency = 'usd',
): LedgerAccountRef => ({
  tenantId,
  code,
  currency,
  immudbAccountId: ledgerAccountId(tenantId, code, currency),
});

const finding = (
  tenantId: string,
  sourceKey: string,
  overrides: Partial<LedgerDiscrepancyInput> = {},
): LedgerDiscrepancyInput => ({
  tenantId,
  kind: 'payment_without_entry',
  sourceKey,
  expected: { amount: '2500', currency: 'usd' },
  actual: { amount: null },
  detectedBy: 'R3',
  runId: null,
  ...overrides,
});

const state = (txId: bigint, hash: number[]): LedgerTrustedState => ({
  database: 'ledger',
  txId,
  txHash: new Uint8Array(hash),
});

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'billing ledger repositories (app_runtime receipts, app_system ledger methods; local execution off)',
  () => {
    let database: BillingDatabase | undefined;
    let receipts: DrizzleLedgerReceiptsRepository;
    let system: DrizzleLedgerSystemRepository;
    let outbox: BillingOutboxSystemRepository;
    /** Builds records only (`record()` sends no SQL and needs no transaction). */
    const writer = new BillingOutbox(
      BILLING_OUTBOX,
      {} as DrizzleTransactionHost,
      new FakeKafkaProducer({ source: 'billing-int' }),
    );

    const db = () => database ?? expect.fail('no database');
    const as = <T>(principal: Principal, work: () => Promise<T>): Promise<T> =>
      runWithPrincipal(principal, work);
    const inSystem = <T>(work: () => Promise<T>): Promise<T> =>
      SystemContext.run('billing.ledger-repositories-int', work);
    const keys = async (table: string, columns: string): Promise<string[]> =>
      (
        await db().superuser.execute<{ key: string }>(
          sql.raw(`select ${columns} as key from billing.${table} order by 1`),
        )
      ).map((row) => row.key);
    const refKeys = () => keys('ledger_entry_refs', `tenant_id || '/' || entry_id`);
    const accountKeys = () =>
      keys('ledger_accounts', `tenant_id || '/' || code || '/' || currency`);
    const discrepancyKeys = () => keys('ledger_discrepancies', `tenant_id || '/' || id`);
    const outboxKeys = () => keys('outbox', `tenant_id || '/' || id`);
    const runRows = async () => [
      ...(await db().superuser.execute<{
        id: string;
        status: string;
        counts: unknown;
        finished: boolean;
      }>(sql`select id, status, counts, finished_at is not null as finished
        from billing.ledger_reconciliation_runs order by id`)),
    ];
    const trustedRows = async () => [
      ...(await db().superuser.execute<{ database: string; tx_id: string; hash: string }>(sql`
        select database, tx_id::text, encode(tx_hash, 'hex') as hash
        from billing.ledger_trusted_state order by database`)),
    ];
    const everything = async () => [
      await refKeys(),
      await accountKeys(),
      await discrepancyKeys(),
      await outboxKeys(),
      await runRows(),
      await trustedRows(),
    ];

    beforeAll(async () => {
      database = await startBillingDatabase([
        DrizzleLedgerReceiptsRepository,
        DrizzleLedgerSystemRepository,
        BillingOutboxSystemRepository,
      ]);
      receipts = database.app.get(DrizzleLedgerReceiptsRepository);
      system = database.app.get(DrizzleLedgerSystemRepository);
      outbox = database.app.get(BillingOutboxSystemRepository);
    });

    afterAll(async () => {
      await database?.close();
    });

    beforeEach(async () => {
      await db().superuser.execute(sql`truncate billing.payments, billing.outbox,
        billing.ledger_accounts, billing.ledger_entry_refs, billing.ledger_discrepancies,
        billing.ledger_reconciliation_runs, billing.ledger_trusted_state`);
    });

    describe('LedgerReceiptsRepository (app_runtime, a non-elevated member)', () => {
      it('the app runs as app_runtime', async () => {
        const [row] = await db().db.execute<{ user: string }>(sql`select current_user as user`);
        expect(row).toEqual({ user: 'app_runtime' });
      });

      it('recordEntryRef returns true, then false for the same entry, and stores every field', async () => {
        const entry = ref(TENANT_A, id('e1'), { paymentId: id('p1') });
        await expect(as(a1, () => receipts.recordEntryRef(entry))).resolves.toBe(true);
        await expect(as(a1, () => receipts.recordEntryRef(entry))).resolves.toBe(false);
        // The same key with other fields is still "already recorded": the first ref stays.
        await expect(
          as(a1, () => receipts.recordEntryRef({ ...entry, immudbTxId: null, payloadHash: 'b' })),
        ).resolves.toBe(false);
        const rows = await db().superuser.execute<Record<string, string | null>>(sql`
          select tenant_id::text, entry_id::text, source_key, payload_hash, immudb_tx_id::text,
            payment_id::text, kind, posted_at::text from billing.ledger_entry_refs`);
        expect([...rows]).toEqual([
          {
            tenant_id: TENANT_A,
            entry_id: entry.entryId,
            source_key: entry.sourceKey,
            payload_hash: entry.payloadHash,
            immudb_tx_id: '9007199254740993',
            payment_id: id('p1'),
            kind: 'charge',
            posted_at: '2026-11-10 10:00:00+00',
          },
        ]);
      });

      it("a ref for tenant B or the platform is rejected by the policy (42501), as is b1's write as a1", async () => {
        await expect(
          sqlState(as(a1, () => receipts.recordEntryRef(ref(TENANT_B, id('e2'))))),
        ).resolves.toBe('42501');
        await expect(
          sqlState(as(a1, () => receipts.recordEntryRef(ref(PLATFORM_TENANT_ID, id('e3'))))),
        ).resolves.toBe('42501');
        expect(await refKeys()).toEqual([]);
        await expect(as(b1, () => receipts.recordEntryRef(ref(TENANT_B, id('e2'))))).resolves.toBe(
          true,
        );
        expect(await refKeys()).toEqual([`${TENANT_B}/${id('e2')}`]);
      });

      it('recordAccounts is idempotent: a repeat or an overlapping batch adds only the new rows', async () => {
        const revenue = account(TENANT_A, 'revenue:checkout');
        const refunds = account(TENANT_A, 'contra_revenue:refunds');
        await as(a1, () => receipts.recordAccounts([revenue, refunds]));
        await as(a1, () => receipts.recordAccounts([revenue, refunds]));
        await as(a1, () =>
          receipts.recordAccounts([refunds, account(TENANT_A, 'revenue:checkout', 'eur')]),
        );
        await as(a1, () => receipts.recordAccounts([]));
        expect(await accountKeys()).toEqual(
          [
            `${TENANT_A}/revenue:checkout/usd`,
            `${TENANT_A}/contra_revenue:refunds/usd`,
            `${TENANT_A}/revenue:checkout/eur`,
          ].toSorted(),
        );
      });

      it('recordAccounts throws before SQL for a platform-owned row, and writes none of the batch', async () => {
        const revenue = account(TENANT_A, 'revenue:checkout');
        for (const platformOwned of [
          account(PLATFORM_TENANT_ID, 'asset:stripe_balance'),
          account(PLATFORM_TENANT_ID, 'revenue:checkout'),
          // A platform account code under the tenant: its id is the platform's account.
          { ...account(TENANT_A, 'expense:stripe_fees') },
        ]) {
          await expect(
            as(a1, () => receipts.recordAccounts([revenue, platformOwned])),
          ).rejects.toThrow(/platform/);
          // Even without a principal: the check runs before the unit of work opens.
          await expect(receipts.recordAccounts([platformOwned])).rejects.toThrow(/platform/);
        }
        expect(await accountKeys()).toEqual([]);
        await expect(
          sqlState(as(a1, () => receipts.recordAccounts([account(TENANT_B, 'revenue:checkout')]))),
        ).resolves.toBe('42501');
      });

      it('appendDiscrepancy returns true, then false for the identical finding, true for another one', async () => {
        const first = finding(TENANT_A, `payment:${id('p1')}`, { detectedBy: 'consumer' });
        await expect(as(a1, () => receipts.appendDiscrepancy(first))).resolves.toBe(true);
        await expect(as(a1, () => receipts.appendDiscrepancy(first))).resolves.toBe(false);
        // Another detector or run of the same finding is the same row.
        await expect(
          as(a1, () => receipts.appendDiscrepancy({ ...first, detectedBy: 'R3', runId: id('r1') })),
        ).resolves.toBe(false);
        const other = { ...first, actual: { amount: '2400' } };
        await expect(as(a1, () => receipts.appendDiscrepancy(other))).resolves.toBe(true);
        expect(await discrepancyKeys()).toEqual(
          [
            `${TENANT_A}/${ledgerDiscrepancyId(first)}`,
            `${TENANT_A}/${ledgerDiscrepancyId(other)}`,
          ].toSorted(),
        );
        const [row] = await db().superuser.execute<Record<string, unknown>>(sql`
          select kind, source_key, expected, actual, detected_by, run_id, resolves_id
          from billing.ledger_discrepancies where id = ${ledgerDiscrepancyId(first)}`);
        expect(row).toEqual({
          kind: 'payment_without_entry',
          source_key: first.sourceKey,
          expected: { amount: '2500', currency: 'usd' },
          actual: { amount: null },
          detected_by: 'consumer',
          run_id: null,
          resolves_id: null,
        });
        await expect(
          sqlState(as(a1, () => receipts.appendDiscrepancy(finding(TENANT_B, 'x')))),
        ).resolves.toBe('42501');
      });

      it('every method is refused with no principal, before BEGIN (RLS_NO_PRINCIPAL)', async () => {
        await expect(receipts.recordEntryRef(ref(TENANT_A, id('e1')))).rejects.toMatchObject(
          NO_PRINCIPAL,
        );
        await expect(
          receipts.recordAccounts([account(TENANT_A, 'revenue:checkout')]),
        ).rejects.toMatchObject(NO_PRINCIPAL);
        await expect(receipts.appendDiscrepancy(finding(TENANT_A, 'x'))).rejects.toMatchObject(
          NO_PRINCIPAL,
        );
        // SystemContext has no principal either: the runtime door stays shut.
        await expect(
          inSystem(() => receipts.recordEntryRef(ref(TENANT_A, id('e1')))),
        ).rejects.toMatchObject(NO_PRINCIPAL);
        expect(await everything()).toEqual([[], [], [], [], [], []]);
      });
    });

    describe('LedgerSystemRepository (app_system, SystemContext only)', () => {
      const FROM = new Date('2026-11-10T00:00:00.000Z');
      const TO = new Date('2026-11-11T00:00:00.000Z');
      const inside = (minutes: number) => new Date(FROM.getTime() + minutes * 60_000);

      /** Drains a keyset list with `limit` per page; returns every page. */
      const pages = async <T extends { tenantId: string }>(
        list: (after: LedgerCursor | null) => Promise<readonly T[]>,
        cursorOf: (row: T) => LedgerCursor,
        limit: number,
      ): Promise<T[][]> => {
        const out: T[][] = [];
        let after: LedgerCursor | null = null;
        for (;;) {
          const page = [...(await list(after))];
          out.push(page);
          const last = page.at(-1);
          if (page.length < limit || last === undefined) return out;
          after = cursorOf(last);
        }
      };

      it('listSucceededPayments: every tenant, the platform included, paid in [from, to), in (tenant_id, id) order over three pages', async () => {
        const seeded: {
          tenantId: string;
          id: string;
          status: PaymentStatus;
          paidAt: Date | null;
        }[] = [];
        let n = 0;
        const seed = (tenantId: string, status: PaymentStatus, paidAt: Date | null) => {
          n += 1;
          seeded.push({ tenantId, id: id(`f${n}`), status, paidAt });
        };
        for (const tenant of [TENANT_A, TENANT_B, PLATFORM_TENANT_ID]) {
          seed(tenant, PaymentStatus.Succeeded, FROM); // the window's first instant: in
          seed(tenant, PaymentStatus.Refunded, inside(10));
        }
        seed(TENANT_A, PaymentStatus.PartiallyRefunded, inside(20));
        seed(TENANT_B, PaymentStatus.Disputed, inside(30));
        // Out: at `to`, before `from`, never paid, or not a paid status.
        seed(TENANT_A, PaymentStatus.Succeeded, TO);
        seed(TENANT_B, PaymentStatus.Succeeded, new Date(FROM.getTime() - 1));
        seed(TENANT_A, PaymentStatus.Pending, null);
        seed(TENANT_B, PaymentStatus.Failed, inside(40));
        seed(TENANT_A, PaymentStatus.Expired, inside(50));
        await db()
          .superuser.insert(payments)
          .values(
            seeded.map((row) => ({
              tenantId: row.tenantId,
              id: row.id,
              userId: row.tenantId === TENANT_B ? B1 : A1,
              priceId: 'price_1',
              quantity: 1,
              amountTotal: 2_500,
              currency: 'usd',
              status: row.status,
              paidAt: row.paidAt,
            })),
          );

        const all = await pages(
          (after) => inSystem(() => system.listSucceededPayments(FROM, TO, after, 3)),
          (row) => ({ tenantId: row.tenantId, id: row.id }),
          3,
        );
        expect(all.map((page) => page.length)).toEqual([3, 3, 2]);
        const listed = all.flat();
        const expected = seeded
          .slice(0, 8)
          .map(({ tenantId, id: paymentId }) => `${tenantId}/${paymentId}`)
          .toSorted();
        expect(listed.map((row) => `${row.tenantId}/${row.id}`)).toEqual(expected);
        expect(listed.find((row) => row.status === PaymentStatus.Disputed)).toEqual({
          tenantId: TENANT_B,
          id: seeded[7]?.id,
          userId: B1,
          status: PaymentStatus.Disputed,
          amountTotal: 2_500n,
          currency: 'usd',
          paidAt: inside(30),
        });
      });

      it('listEntryRefs: every tenant, the platform included, posted in [from, to), in (tenant_id, id) order over three pages', async () => {
        const rows = [
          ref(TENANT_A, id('e1'), { postedAt: FROM }),
          ref(TENANT_A, id('e2'), { postedAt: inside(5), immudbTxId: null }),
          ref(TENANT_A, id('e3'), { postedAt: inside(6), kind: 'refund', paymentId: id('p1') }),
          ref(TENANT_B, id('e4'), { postedAt: inside(7) }),
          ref(TENANT_B, id('e5'), { postedAt: inside(8) }),
          ref(PLATFORM_TENANT_ID, id('e6'), { postedAt: inside(9), kind: 'payout' }),
          ref(PLATFORM_TENANT_ID, id('e7'), { postedAt: inside(10) }),
        ];
        const outside = [
          ref(TENANT_A, id('e8'), { postedAt: TO }),
          ref(TENANT_B, id('e9'), { postedAt: new Date(FROM.getTime() - 1) }),
        ];
        await inSystem(() => system.recordEntryRefs([...rows, ...outside]));

        const all = await pages(
          (after) => inSystem(() => system.listEntryRefs(FROM, TO, after, 3)),
          (row) => ({ tenantId: row.tenantId, id: row.entryId }),
          3,
        );
        expect(all.map((page) => page.length)).toEqual([3, 3, 1]);
        const listed = all.flat();
        expect(listed.map((row) => `${row.tenantId}/${row.entryId}`)).toEqual(
          rows.map((row) => `${row.tenantId}/${row.entryId}`).toSorted(),
        );
        // Every field round-trips (int8 beyond 2^53 as a bigint, a null tx id, the payment).
        expect(listed).toEqual(expect.arrayContaining(rows));
      });

      it('appendDiscrepancies returns the count of new rows: 0 for the same batch again', async () => {
        const batch = [
          finding(TENANT_A, 'a', { runId: id('r1') }),
          finding(TENANT_B, 'b', { runId: id('r1'), kind: 'tenant_mismatch' }),
          finding(PLATFORM_TENANT_ID, 'state:ledger', {
            runId: id('r1'),
            kind: 'verification_failed',
            detectedBy: 'R5',
          }),
        ];
        await expect(inSystem(() => system.appendDiscrepancies(batch))).resolves.toBe(3);
        await expect(inSystem(() => system.appendDiscrepancies(batch))).resolves.toBe(0);
        // An overlapping window of a later run: one new finding, the rest are the same rows.
        const later = batch.map((row) => ({ ...row, runId: id('r2') }));
        const fresh = finding(TENANT_A, 'c', { runId: id('r2') });
        await expect(
          inSystem(() => system.appendDiscrepancies([...later, fresh, fresh])),
        ).resolves.toBe(1);
        await expect(inSystem(() => system.appendDiscrepancies([]))).resolves.toBe(0);
        expect(await discrepancyKeys()).toEqual(
          [...batch, fresh].map((row) => `${row.tenantId}/${ledgerDiscrepancyId(row)}`).toSorted(),
        );
      });

      it('enqueueMissingPostings inserts into billing.outbox for two tenants and the platform, idempotent by id; the poll returns them', async () => {
        const record = (tenantId: string, eventId: string): OutboxRecord =>
          writer.record(
            PAYMENT_SUCCEEDED_EVENT,
            {
              paymentId: id('p9'),
              userId: A1,
              stripeCheckoutSessionId: 'cs_reconcile',
              amountTotal: 100,
              currency: 'usd',
              paidAt: FROM.toISOString(),
            },
            { tenantId, actorId: null, key: tenantId, eventId },
          );
        const records = [
          record(TENANT_A, id('o1')),
          record(TENANT_B, id('o2')),
          record(PLATFORM_TENANT_ID, id('o3')),
        ];
        await expect(inSystem(() => system.enqueueMissingPostings(records))).resolves.toBe(3);
        await expect(inSystem(() => system.enqueueMissingPostings(records))).resolves.toBe(0);
        await expect(inSystem(() => system.enqueueMissingPostings([]))).resolves.toBe(0);
        const poll = await inSystem(() => outbox.pollUnpublished(10));
        expect(poll.rows.map((row) => `${row.tenantId}/${row.id}`).toSorted()).toEqual(
          records.map((row) => `${row.tenantId}/${row.id}`).toSorted(),
        );
        expect(poll.rows.find((row) => row.id === id('o3'))).toMatchObject({
          tenantId: PLATFORM_TENANT_ID,
          topic: PAYMENT_SUCCEEDED_EVENT.topic,
          key: PLATFORM_TENANT_ID,
          envelope: { id: id('o3'), tenantId: PLATFORM_TENANT_ID },
        });
        // A record whose row does not match its envelope is refused before SQL.
        const [first] = records;
        await expect(
          inSystem(() =>
            system.enqueueMissingPostings([{ ...(first ?? expect.fail()), tenantId: TENANT_B }]),
          ),
        ).rejects.toThrow(/envelope/);
        await expect(
          inSystem(() =>
            system.enqueueMissingPostings([{ ...(first ?? expect.fail()), id: id('o4') }]),
          ),
        ).rejects.toThrow(/envelope/);
        expect(await outboxKeys()).toHaveLength(3);
      });

      it('recordEntryRefs is idempotent across tenants', async () => {
        const rows = [
          ref(TENANT_A, id('e1')),
          ref(TENANT_B, id('e2')),
          ref(PLATFORM_TENANT_ID, id('e3'), { kind: 'payout' }),
        ];
        await expect(inSystem(() => system.recordEntryRefs(rows))).resolves.toBe(3);
        await expect(inSystem(() => system.recordEntryRefs(rows))).resolves.toBe(0);
        await expect(
          inSystem(() => system.recordEntryRefs([...rows, ref(TENANT_B, id('e4'))])),
        ).resolves.toBe(1);
        await expect(inSystem(() => system.recordEntryRefs([]))).resolves.toBe(0);
        expect(await refKeys()).toHaveLength(4);
      });

      it('recordPlatformAccounts writes platform rows idempotently and throws before SQL for a non-platform row', async () => {
        const rows = [
          account(PLATFORM_TENANT_ID, 'asset:stripe_balance'),
          account(PLATFORM_TENANT_ID, 'expense:stripe_fees'),
          // An unresolved owner's posting lands on the platform tenant with tenant-owned codes.
          account(PLATFORM_TENANT_ID, 'revenue:checkout'),
        ];
        await expect(inSystem(() => system.recordPlatformAccounts(rows))).resolves.toBe(3);
        await expect(inSystem(() => system.recordPlatformAccounts(rows))).resolves.toBe(0);
        await expect(
          inSystem(() =>
            system.recordPlatformAccounts([
              account(PLATFORM_TENANT_ID, 'asset:bank'),
              account(TENANT_A, 'revenue:checkout'),
            ]),
          ),
        ).rejects.toThrow(/PLATFORM_TENANT_ID/);
        expect(await accountKeys()).toEqual(
          rows.map((row) => `${row.tenantId}/${row.code}/${row.currency}`).toSorted(),
        );
      });

      it('advanceTrustedState is a compare-and-set: null → s1 once, s1 → s2, a stale s1 → s3 leaves s2', async () => {
        const s1 = state(10n, [0x01, 0x02]);
        const s2 = state(12n, [0x03, 0x04]);
        const s3 = state(13n, [0x05]);
        await expect(inSystem(() => system.readTrustedState('ledger'))).resolves.toBeNull();
        await expect(inSystem(() => system.advanceTrustedState('ledger', null, s1))).resolves.toBe(
          true,
        );
        await expect(inSystem(() => system.advanceTrustedState('ledger', null, s1))).resolves.toBe(
          false,
        );
        await expect(inSystem(() => system.advanceTrustedState('ledger', s1, s2))).resolves.toBe(
          true,
        );
        await expect(inSystem(() => system.advanceTrustedState('ledger', s1, s3))).resolves.toBe(
          false,
        );
        // The right tx id with another hash is stale too.
        await expect(
          inSystem(() => system.advanceTrustedState('ledger', state(12n, [0xff]), s3)),
        ).resolves.toBe(false);
        expect(await trustedRows()).toEqual([{ database: 'ledger', tx_id: '12', hash: '0304' }]);

        const read = await inSystem(() => system.readTrustedState('ledger'));
        expect(read).toEqual({
          database: 'ledger',
          txId: 12n,
          txHash: new Uint8Array([0x03, 0x04]),
          verifiedAt: expect.any(Date),
        });
        expect(Object.getPrototypeOf(read?.txHash)).toBe(Uint8Array.prototype);
        // An equal state re-verified: allowed (no new transaction since).
        await expect(inSystem(() => system.advanceTrustedState('ledger', s2, s2))).resolves.toBe(
          true,
        );
        // Another database is its own row.
        await expect(
          inSystem(() => system.advanceTrustedState('other', null, { ...s1, database: 'other' })),
        ).resolves.toBe(true);
        expect(await trustedRows()).toHaveLength(2);
      });

      it('advanceTrustedState throws before SQL when to.txId < from.txId or a state names another database', async () => {
        const s2 = state(12n, [0x03]);
        await inSystem(() => system.advanceTrustedState('ledger', null, s2));
        const before = await trustedRows();
        await expect(
          inSystem(() => system.advanceTrustedState('ledger', s2, state(11n, [0x09]))),
        ).rejects.toThrow(/backwards/);
        await expect(
          inSystem(() =>
            system.advanceTrustedState('ledger', s2, { ...state(13n, [0x09]), database: 'other' }),
          ),
        ).rejects.toThrow(/database/);
        await expect(
          inSystem(() =>
            system.advanceTrustedState('ledger', { ...s2, database: 'other' }, state(13n, [0x09])),
          ),
        ).rejects.toThrow(/database/);
        expect(await trustedRows()).toEqual(before);
      });

      it('startRun records a running run; finishRun finishes it once and a second finish changes nothing', async () => {
        const runId = id('r1');
        await inSystem(() => system.startRun({ id: runId, from: FROM, to: TO }));
        expect(await runRows()).toEqual([
          { id: runId, status: 'running', counts: { found: {}, appended: {} }, finished: false },
        ]);
        const counts = { found: { missing_entry: 2 }, appended: { missing_entry: 1 } };
        await inSystem(() => system.finishRun(runId, 'succeeded', counts));
        await inSystem(() =>
          system.finishRun(runId, 'failed', { found: { x: 9 }, appended: { x: 9 } }),
        );
        expect(await runRows()).toEqual([
          { id: runId, status: 'succeeded', counts, finished: true },
        ]);
        const [window] = await db().superuser.execute<{ fromOk: boolean; toOk: boolean }>(sql`
          select from_ts = ${FROM.toISOString()}::timestamptz as "fromOk",
            to_ts = ${TO.toISOString()}::timestamptz as "toOk"
          from billing.ledger_reconciliation_runs`);
        expect(window).toEqual({ fromOk: true, toOk: true });
      });

      it('every method is refused outside SystemContext, with or without a principal', async () => {
        const calls: Record<keyof LedgerSystemRepository, () => Promise<unknown>> = {
          listSucceededPayments: () => system.listSucceededPayments(FROM, TO, null, 10),
          listEntryRefs: () => system.listEntryRefs(FROM, TO, null, 10),
          appendDiscrepancies: () => system.appendDiscrepancies([finding(TENANT_A, 'a')]),
          enqueueMissingPostings: () => system.enqueueMissingPostings([]),
          recordEntryRefs: () => system.recordEntryRefs([ref(TENANT_A, id('e1'))]),
          recordPlatformAccounts: () =>
            system.recordPlatformAccounts([account(PLATFORM_TENANT_ID, 'asset:bank')]),
          readTrustedState: () => system.readTrustedState('ledger'),
          advanceTrustedState: () => system.advanceTrustedState('ledger', null, state(1n, [1])),
          startRun: () => system.startRun({ id: id('r1'), from: FROM, to: TO }),
          finishRun: () => system.finishRun(id('r1'), 'failed', { found: {}, appended: {} }),
        };
        for (const [name, call] of Object.entries(calls)) {
          await expect(call(), name).rejects.toMatchObject(SYSTEM_CONTEXT_REQUIRED);
          await expect(as(a1, call), name).rejects.toMatchObject(SYSTEM_CONTEXT_REQUIRED);
          // A principal inside SystemContext ends system status too.
          await expect(
            inSystem(() => as(a1, call)),
            name,
          ).rejects.toMatchObject(SYSTEM_CONTEXT_REQUIRED);
        }
        expect(await everything()).toEqual([[], [], [], [], [], []]);
      });

      it('no UPDATE or DELETE exists for ledger_entry_refs or ledger_discrepancies in either repository', () => {
        for (const file of [
          'drizzle-ledger.system-repository.ts',
          'drizzle-ledger-receipts.repository.ts',
          'ledger-row.mapper.ts',
        ]) {
          const source = readFileSync(join(import.meta.dirname, file), 'utf8');
          expect(source, file).not.toMatch(
            /\.(?:update|delete)\(\s*ledger(?:EntryRefs|Discrepancies)\b/,
          );
          expect(source, file).not.toMatch(
            /\b(?:update|delete\s+from)\s+billing\.ledger_(?:entry_refs|discrepancies)/i,
          );
        }
      });
    });
  },
);
