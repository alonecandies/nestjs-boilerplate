import {
  createPrincipal,
  PLATFORM_TENANT_ID,
  type Principal,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BillingDatabase, startBillingDatabase } from '../../../test/billing-database.js';
import { makePayment } from '../../../test/billing-test.utils.js';
import type { PaymentsRepository } from '../../application/repositories/payments.repository.js';
import type {
  StripeEventReceipt,
  StripeEventsRepository,
} from '../../application/repositories/stripe-events.repository.js';
import { PaymentConcurrentlyModifiedException } from '../../domain/billing.errors.js';
import type { Payment } from '../../domain/payment.aggregate.js';
import { payments as paymentsTable } from './billing.schema.js';
import { DrizzlePaymentsRepository } from './drizzle-payments.repository.js';
import { DrizzleStripeEventsRepository } from './drizzle-stripe-events.repository.js';
import { DrizzleStripeEventsSystemRepository } from './drizzle-stripe-events.system-repository.js';
import { toPaymentRow } from './payment-row.mapper.js';

/*
 * Billing's repositories on the roles of production (B3-8, B3-11, B3-15): the real DatabaseModule
 * on the three URLs of startRlsTestPostgres (local execution off), migrations as app_owner, the app
 * as app_runtime under 0003's forced RLS, the system repository as app_system. Seeding and
 * assertions go through the superuser.
 * - Every public method of both runtime ports (a table the compiler keeps exhaustive), called
 *   standalone as the right principal, opens its own unit of work and returns the expected rows;
 *   with no principal it is refused before BEGIN (RLS_NO_PRINCIPAL).
 * - The system methods run only in SystemContext; markProcessedAsPlatform is idempotent and
 *   refuses a receipt with a user; the runtime markProcessed cannot write platform rows.
 * Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project billing:int billing.repositories.rls
 */

const TENANT_A = '0197c100-0000-7000-8000-0000000000a0';
const TENANT_B = '0197c100-0000-7000-8000-0000000000b0';
const A1 = '0197c100-0000-7000-8000-00000000a001';
const A2 = '0197c100-0000-7000-8000-00000000a002';
const B1 = '0197c100-0000-7000-8000-00000000b001';

const a1 = createPrincipal({ userId: A1, tenantId: TENANT_A, roles: ['admin'] });
const a2 = createPrincipal({ userId: A2, tenantId: TENANT_A, roles: ['member'] });

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

const NO_PRINCIPAL = { name: 'RlsContextError', code: 'RLS_NO_PRINCIPAL' };
const SYSTEM_CONTEXT_REQUIRED = { name: 'SystemDatabaseError', code: 'SYSTEM_CONTEXT_REQUIRED' };

type PaymentRowView = {
  tenant_id: string;
  id: string;
  user_id: string;
  status: string;
  version: number;
};

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'billing repositories under RLS (app_runtime, app_system, local execution off)',
  () => {
    let database: BillingDatabase | undefined;
    let payments: DrizzlePaymentsRepository;
    let events: DrizzleStripeEventsRepository;
    let system: DrizzleStripeEventsSystemRepository;
    /** Fresh per case: one payment each for a1 (with a Checkout Session), a2 and b1. */
    let payA1: Payment;
    let payA2: Payment;
    let payB1: Payment;

    const db = () => database ?? expect.fail('no database');
    const paymentRows = async (): Promise<PaymentRowView[]> => [
      ...(await db().superuser.execute<PaymentRowView>(sql`
        select tenant_id, id, user_id, status, version from billing.payments order by id`)),
    ];
    const eventRows = async (): Promise<string[]> =>
      (
        await db().superuser.execute<{ key: string }>(sql`
          select tenant_id || '/' || id || '/' || coalesce(user_id::text, '-') as key
          from billing.stripe_events order by 1`)
      ).map((row) => row.key);
    const as = <T>(principal: Principal, work: () => Promise<T>): Promise<T> =>
      runWithPrincipal(principal, work);
    const inSystem = <T>(work: () => Promise<T>): Promise<T> =>
      SystemContext.run('billing.repositories-int', work);

    beforeAll(async () => {
      database = await startBillingDatabase([
        DrizzlePaymentsRepository,
        DrizzleStripeEventsRepository,
        DrizzleStripeEventsSystemRepository,
      ]);
      payments = database.app.get(DrizzlePaymentsRepository);
      events = database.app.get(DrizzleStripeEventsRepository);
      system = database.app.get(DrizzleStripeEventsSystemRepository);
    });

    afterAll(async () => {
      await database?.close();
    });

    beforeEach(async () => {
      await db().superuser.execute(sql`truncate billing.payments, billing.stripe_events`);
      payA1 = makePayment({ tenantId: TENANT_A, userId: A1, stripeCheckoutSessionId: 'cs_a1' });
      payA2 = makePayment({ tenantId: TENANT_A, userId: A2 });
      payB1 = makePayment({ tenantId: TENANT_B, userId: B1 });
      await db().superuser.insert(paymentsTable).values([payA1, payA2, payB1].map(toPaymentRow));
    });

    it('the app runs as app_runtime', async () => {
      const [row] = await db().db.execute<{ user: string }>(sql`select current_user as user`);
      expect(row).toEqual({ user: 'app_runtime' });
    });

    /**
     * One case per public method of each runtime port: who calls it, what it does, and what it
     * must return. Adding a method to a port without a case here is a compile error.
     */
    const cases: {
      [K in
        | keyof PaymentsRepository
        | `stripeEvents.${keyof StripeEventsRepository}`]: () => Promise<void>;
    } = {
      create: async () => {
        const payment = makePayment({ tenantId: TENANT_A, userId: A2, idempotencyKey: 'k-1' });
        const first = await as(a2, () => payments.create(payment));
        const replay = await as(a2, () =>
          payments.create(makePayment({ tenantId: TENANT_A, userId: A2, idempotencyKey: 'k-1' })),
        );
        expect(first.created).toBe(true);
        expect(replay).toMatchObject({ created: false, payment: { id: payment.id } });
        expect((await paymentRows()).filter((row) => row.id === payment.id)).toEqual([
          expect.objectContaining({ tenant_id: TENANT_A, user_id: A2 }),
        ]);
      },
      findById: async () => {
        await expect(as(a2, () => payments.findById(TENANT_A, payA2.id))).resolves.toMatchObject({
          id: payA2.id,
          userId: A2,
        });
        // RLS: another user's payment of the same tenant, and another tenant's, are invisible.
        await expect(as(a2, () => payments.findById(TENANT_A, payA1.id))).resolves.toBeNull();
        await expect(as(a2, () => payments.findById(TENANT_B, payB1.id))).resolves.toBeNull();
      },
      findForCheckoutSession: async () => {
        const ref = { tenantId: TENANT_A, paymentId: payA1.id, sessionId: 'cs_a1' };
        await expect(as(a1, () => payments.findForCheckoutSession(ref))).resolves.toMatchObject({
          id: payA1.id,
        });
        await expect(as(a2, () => payments.findForCheckoutSession(ref))).resolves.toBeNull();
      },
      save: async () => {
        const own = (await as(a1, () => payments.findById(TENANT_A, payA1.id))) ?? expect.fail();
        own.markFailed(new Date('2026-09-02T00:00:00.000Z'));
        await as(a1, () => payments.save(own));
        expect((await paymentRows()).find((row) => row.id === payA1.id)).toMatchObject({
          status: 'failed',
          version: payA1.version + 1,
        });
        // Another user's payment: the policy hides it, 0 rows, the optimistic-lock error.
        payA2.markFailed(new Date('2026-09-02T00:00:00.000Z'));
        await expect(as(a1, () => payments.save(payA2))).rejects.toBeInstanceOf(
          PaymentConcurrentlyModifiedException,
        );
        expect((await paymentRows()).find((row) => row.id === payA2.id)).toMatchObject({
          status: 'pending',
          version: payA2.version,
        });
      },
      list: async () => {
        const mine = await as(a2, () =>
          payments.list({ tenantId: TENANT_A, userId: A2, limit: 10 }),
        );
        expect(mine.items.map((p) => p.id)).toEqual([payA2.id]);
        // The whole tenant, unelevated: the policy still returns only the caller's rows.
        const tenant = await as(a2, () => payments.list({ tenantId: TENANT_A, limit: 10 }));
        expect(tenant.items.map((p) => p.id)).toEqual([payA2.id]);
        const other = await as(a2, () => payments.list({ tenantId: TENANT_B, limit: 10 }));
        expect(other.items).toEqual([]);
      },
      'stripeEvents.markProcessed': async () => {
        const receipt = { tenantId: TENANT_A, userId: A1, id: 'evt_a1', type: 't' };
        await expect(as(a1, () => events.markProcessed(receipt))).resolves.toBe(true);
        await expect(as(a1, () => events.markProcessed(receipt))).resolves.toBe(false);
        expect(await eventRows()).toEqual([`${TENANT_A}/evt_a1/${A1}`]);
      },
    };

    /** The same methods, called with no principal at all. */
    const unauthenticated: { [K in keyof typeof cases]: () => Promise<unknown> } = {
      create: () => payments.create(makePayment({ tenantId: TENANT_A, userId: A1 })),
      findById: () => payments.findById(TENANT_A, payA1.id),
      findForCheckoutSession: () =>
        payments.findForCheckoutSession({
          tenantId: TENANT_A,
          paymentId: null,
          sessionId: 'cs_a1',
        }),
      save: () => payments.save(payA1),
      list: () => payments.list({ tenantId: TENANT_A, limit: 10 }),
      'stripeEvents.markProcessed': () =>
        events.markProcessed({ tenantId: TENANT_A, userId: A1, id: 'evt_x', type: 't' }),
    };

    describe('runtime ports, each method standalone', () => {
      for (const [method, run] of Object.entries(cases)) {
        it(`${method}: as the right principal, the expected rows`, run);
      }

      for (const [method, run] of Object.entries(unauthenticated)) {
        it(`${method}: with no principal, refused before BEGIN (RLS_NO_PRINCIPAL)`, async () => {
          const before = [await paymentRows(), await eventRows()];
          await expect(run()).rejects.toMatchObject(NO_PRINCIPAL);
          expect([await paymentRows(), await eventRows()]).toEqual(before);
        });
      }

      it('a runtime markProcessed for the platform tenant, or without a user, is rejected by the policy', async () => {
        const platform = { tenantId: PLATFORM_TENANT_ID, userId: A1, id: 'evt_p', type: 'p' };
        await expect(sqlState(as(a1, () => events.markProcessed(platform)))).resolves.toBe('42501');
        const platformNoUser = { ...platform, userId: null };
        await expect(sqlState(as(a1, () => events.markProcessed(platformNoUser)))).resolves.toBe(
          '42501',
        );
        const userless = { tenantId: TENANT_A, userId: null, id: 'evt_u', type: 'u' };
        await expect(sqlState(as(a1, () => events.markProcessed(userless)))).resolves.toBe('42501');
        expect(await eventRows()).toEqual([]);
      });
    });

    describe('StripeEventsSystemRepository (app_system, SystemContext only)', () => {
      const payout: StripeEventReceipt = {
        tenantId: PLATFORM_TENANT_ID,
        userId: null,
        id: 'evt_payout',
        type: 'payout.paid',
      };

      it('both methods are refused outside SystemContext, with or without a principal', async () => {
        await expect(system.markProcessedAsPlatform(payout)).rejects.toMatchObject(
          SYSTEM_CONTEXT_REQUIRED,
        );
        await expect(system.deleteProcessedBefore(new Date())).rejects.toMatchObject(
          SYSTEM_CONTEXT_REQUIRED,
        );
        await expect(as(a1, () => system.markProcessedAsPlatform(payout))).rejects.toMatchObject(
          SYSTEM_CONTEXT_REQUIRED,
        );
        await expect(as(a1, () => system.deleteProcessedBefore(new Date()))).rejects.toMatchObject(
          SYSTEM_CONTEXT_REQUIRED,
        );
        // A principal inside SystemContext ends system status too.
        await expect(
          inSystem(() => as(a1, () => system.markProcessedAsPlatform(payout))),
        ).rejects.toMatchObject(SYSTEM_CONTEXT_REQUIRED);
        expect(await eventRows()).toEqual([]);
      });

      it('markProcessedAsPlatform records a platform event once (second call false)', async () => {
        await expect(inSystem(() => system.markProcessedAsPlatform(payout))).resolves.toBe(true);
        await expect(inSystem(() => system.markProcessedAsPlatform(payout))).resolves.toBe(false);
        expect(await eventRows()).toEqual([`${PLATFORM_TENANT_ID}/evt_payout/-`]);
      });

      it('markProcessedAsPlatform records a user-less event of a tenant in that tenant', async () => {
        const userless = { tenantId: TENANT_B, userId: null, id: 'evt_userless', type: 'charge' };
        await expect(inSystem(() => system.markProcessedAsPlatform(userless))).resolves.toBe(true);
        expect(await eventRows()).toEqual([`${TENANT_B}/evt_userless/-`]);
      });

      it('markProcessedAsPlatform rejects a receipt with a user and writes nothing', async () => {
        await expect(
          inSystem(() => system.markProcessedAsPlatform({ ...payout, userId: A1 })),
        ).rejects.toThrow(/user/);
        await expect(
          inSystem(() =>
            system.markProcessedAsPlatform({ tenantId: TENANT_A, userId: A1, id: 'e', type: 't' }),
          ),
        ).rejects.toThrow(/user/);
        expect(await eventRows()).toEqual([]);
      });

      it('deleteProcessedBefore deletes the old events of every tenant, the platform one too', async () => {
        const old = '2026-09-01T00:00:00.000Z';
        const fresh = '2026-10-02T00:00:00.000Z';
        for (const [tenant, user, id, at] of [
          [TENANT_A, A1, 'evt_old_a', old],
          [TENANT_A, A2, 'evt_fresh_a', fresh],
          [TENANT_B, B1, 'evt_old_b', old],
          [PLATFORM_TENANT_ID, null, 'evt_old_p', old],
          [PLATFORM_TENANT_ID, null, 'evt_fresh_p', fresh],
        ] as const) {
          await db().superuser.execute(sql`
            insert into billing.stripe_events (tenant_id, id, user_id, type, processed_at)
            values (${tenant}, ${id}, ${user}, 't', ${at})`);
        }

        const cutoff = new Date('2026-10-01T00:00:00.000Z');
        await expect(inSystem(() => system.deleteProcessedBefore(cutoff))).resolves.toBe(3);
        expect(await eventRows()).toEqual(
          [`${TENANT_A}/evt_fresh_a/${A2}`, `${PLATFORM_TENANT_ID}/evt_fresh_p/-`].toSorted(),
        );
        await expect(inSystem(() => system.deleteProcessedBefore(cutoff))).resolves.toBe(0);
      });

      it('deleteProcessedBefore drains a backlog spread over many 15-minute slices in one run', async () => {
        const cutoff = new Date('2026-10-01T00:00:00.000Z');
        const before = (minutes: number): string =>
          new Date(cutoff.getTime() - minutes * 60_000).toISOString();
        // 12 old events 30 minutes apart over three tenants (the platform one too), one exactly at
        // the cutoff (kept: `<`) and one after it.
        const tenants = [
          [TENANT_A, A1],
          [TENANT_B, B1],
          [PLATFORM_TENANT_ID, null],
        ] as const;
        for (let i = 0; i < 12; i += 1) {
          const [tenant, user] = tenants[i % 3] ?? tenants[0];
          await db().superuser.execute(sql`
            insert into billing.stripe_events (tenant_id, id, user_id, type, processed_at)
            values (${tenant}, ${`evt_backlog_${i}`}, ${user}, 't', ${before((i + 1) * 30)})`);
        }
        await db().superuser.execute(sql`
          insert into billing.stripe_events (tenant_id, id, user_id, type, processed_at) values
            (${TENANT_A}, 'evt_at_cutoff', ${A1}, 't', ${cutoff.toISOString()}),
            (${TENANT_B}, 'evt_after', ${B1}, 't', ${'2026-10-01T00:00:01.000Z'})`);

        await expect(inSystem(() => system.deleteProcessedBefore(cutoff))).resolves.toBe(12);
        expect(await eventRows()).toEqual(
          [`${TENANT_A}/evt_at_cutoff/${A1}`, `${TENANT_B}/evt_after/${B1}`].toSorted(),
        );
      });
    });
  },
);
