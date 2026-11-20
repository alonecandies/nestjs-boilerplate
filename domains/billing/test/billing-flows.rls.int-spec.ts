import type { CheckoutSession, PaymentList } from '@domain/billing-contracts';
import { Global, Module } from '@nestjs/common';
import { CommandBus, CqrsModule, QueryBus } from '@nestjs/cqrs';
import { RbacModule } from '@platform/auth';
import {
  createPrincipal,
  PLATFORM_TENANT_ID,
  type Principal,
  runWithPrincipal,
} from '@platform/common';
import { redisConfig } from '@platform/config';
import {
  getAppliedRlsContext,
  SYSTEM_DATABASE,
  type SystemDatabase,
  TransactionHost,
} from '@platform/database';
import { DistributedLockService, type LockBackend, RedisKeyService } from '@platform/redis';
import { KafkaProducer } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateCheckoutSessionCommand } from '../src/application/commands/create-checkout-session/create-checkout-session.command.js';
import { HandleStripeWebhookCommand } from '../src/application/commands/handle-stripe-webhook/handle-stripe-webhook.command.js';
import { ListPaymentsQuery } from '../src/application/queries/list-payments/list-payments.query.js';
import { PaymentsRepository } from '../src/application/repositories/payments.repository.js';
import { BILLING_RBAC } from '../src/billing.permissions.js';
import { BillingCoreModule } from '../src/billing-core.module.js';
import type { Payment } from '../src/domain/payment.aggregate.js';
import { payments as paymentsTable } from '../src/infrastructure/persistence/billing.schema.js';
import { toPaymentRow } from '../src/infrastructure/persistence/payment-row.mapper.js';
import { PurgeStripeEventsCron } from '../src/infrastructure/scheduling/purge-stripe-events.cron.js';
import { StripeService } from '../src/infrastructure/stripe/stripe.service.js';
import { type BillingDatabase, startBillingDatabase } from './billing-database.js';
import {
  makeCheckoutSession,
  makePayment,
  type SignedWebhook,
  signedEvent,
  TEST_WEBHOOK_SECRET,
} from './billing-test.utils.js';

/*
 * Billing's flows on the roles of production (B3-13, billing; the plan's Task 16 flow table): the
 * billing core on the three URLs of startRlsTestPostgres (local execution off), the app as
 * app_runtime under 0003's forced RLS, the system repository as app_system, a fake Stripe gateway
 * (real signature verification with the test secret, no network). Seeding and assertions go
 * through the superuser.
 * - Webhook, owner with tenant + user: one transaction as { user, tenant, [] }.
 * - Webhook, platform or user-less owner: stripeEvents.markProcessedAsPlatform in
 *   SystemContext('billing.platform-webhook'); no payment is touched.
 * - Checkout and list payments run as the request principal; list with billing:read-all elevates.
 * - The purge cron runs stripeEvents.deleteProcessedBefore in SystemContext.
 * A spy on SystemDatabase.run records every system method the flows use: only those two.
 * Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project billing:int billing-flows.rls
 */

const TENANT_A = '0197c200-0000-7000-8000-0000000000a0';
const TENANT_B = '0197c200-0000-7000-8000-0000000000b0';
const A1 = '0197c200-0000-7000-8000-00000000a001';
const A2 = '0197c200-0000-7000-8000-00000000a002';
const B1 = '0197c200-0000-7000-8000-00000000b001';

/** a1 administers tenant A (billing:read-all), a2 is a member (billing:checkout), b1 is in B. */
const a1 = createPrincipal({ userId: A1, tenantId: TENANT_A, roles: ['admin'] });
const a2 = createPrincipal({ userId: A2, tenantId: TENANT_A, roles: ['member'] });

const MARK_AS_PLATFORM = 'stripeEvents.markProcessedAsPlatform';
const DELETE_PROCESSED = 'stripeEvents.deleteProcessedBefore';

/**
 * The real lock service over a backend that always grants the lock: @WithLock on the purge cron
 * (registered in onModuleInit below) and the outbox relay's injection (the relay is disabled here,
 * OUTBOX_RELAY_ENABLED=false, so its polls never enter this spec's system-method pins).
 */
const locks = new DistributedLockService(
  {
    using: async (
      _keys: string[],
      _ttl: number,
      _settings: unknown,
      routine: (signal: AbortSignal) => Promise<unknown>,
    ) => routine(new AbortController().signal),
  } as unknown as LockBackend,
  new RedisKeyService(redisConfig.parse({ REDIS_KEY_PREFIX: 'billing-int' })),
);

/** What the app's global infrastructure modules provide beyond Postgres: Kafka and locks, faked. */
@Global()
@Module({
  providers: [
    { provide: KafkaProducer, useValue: new FakeKafkaProducer({ source: 'billing-int' }) },
    { provide: DistributedLockService, useValue: locks },
  ],
  exports: [KafkaProducer, DistributedLockService],
})
class FakeKafkaModule {}

type PaymentRowView = { tenant_id: string; id: string; status: string; version: number };

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'billing flows under RLS (B3-13: principals, system methods, local execution off)',
  () => {
    let database: BillingDatabase | undefined;
    let commands: CommandBus;
    let queries: QueryBus;
    let stripe: StripeService;
    let repository: PaymentsRepository;
    let system: SystemDatabase;
    /** Every system method name a flow ran, in order (reset per case). */
    let systemCalls: string[];
    /** Every system method name the whole spec ran. */
    const allSystemCalls = new Set<string>();
    /** How many runtime transactions (or units of work) were opened (reset per case). */
    let runtimeTransactions: number;
    let payA1: Payment;
    let payA2: Payment;
    let payB1: Payment;

    const db = () => database ?? expect.fail('no database');
    const paymentRows = async (): Promise<PaymentRowView[]> => [
      ...(await db().superuser.execute<PaymentRowView>(sql`
        select tenant_id, id, status, version from billing.payments order by id`)),
    ];
    const paymentRow = async (id: string) => (await paymentRows()).find((row) => row.id === id);
    const eventRows = async (): Promise<string[]> =>
      (
        await db().superuser.execute<{ key: string }>(sql`
          select tenant_id || '/' || id || '/' || coalesce(user_id::text, '-') as key
          from billing.stripe_events order by 1`)
      ).map((row) => row.key);
    const as = <T>(principal: Principal, work: () => Promise<T>): Promise<T> =>
      runWithPrincipal(principal, work);
    const deliver = (webhook: SignedWebhook) =>
      commands.execute(new HandleStripeWebhookCommand(webhook.payload, webhook.signature));
    /** A paid `checkout.session.completed` with the given signed metadata. */
    const completed = (
      id: string,
      session: { id: string; paymentId: string },
      metadata: Record<string, string>,
    ) =>
      signedEvent(
        'checkout.session.completed',
        makeCheckoutSession({
          id: session.id,
          client_reference_id: session.paymentId,
          payment_status: 'paid',
          payment_intent: `pi_${id}`,
          amount_total: 2_500,
          currency: 'usd',
          status: 'complete',
          metadata: { paymentId: session.paymentId, ...metadata },
        }),
        { id },
      );

    beforeAll(async () => {
      vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_billing_flows_int');
      vi.stubEnv('STRIPE_WEBHOOK_SECRET', TEST_WEBHOOK_SECRET);
      vi.stubEnv('OUTBOX_RELAY_ENABLED', 'false');
      // @WithLock on the cron: the real lock service over a backend that always grants the lock.
      locks.onModuleInit();
      database = await startBillingDatabase([], {
        imports: [
          CqrsModule.forRoot(),
          RbacModule.forRoot(),
          RbacModule.forFeature(BILLING_RBAC),
          FakeKafkaModule,
          BillingCoreModule,
        ],
      });
      const { app } = database;
      commands = app.get(CommandBus);
      queries = app.get(QueryBus);
      stripe = app.get(StripeService, { strict: false });
      repository = app.get(PaymentsRepository, { strict: false });
      system = app.get<SystemDatabase>(SYSTEM_DATABASE);
    });

    afterAll(async () => {
      await database?.close();
    });

    beforeEach(async () => {
      systemCalls = [];
      runtimeTransactions = 0;
      // Spies go in per case: the workspace config restores every mock before each test.
      const run = system.run.bind(system);
      vi.spyOn(system, 'run').mockImplementation((method, work) => {
        systemCalls.push(method.name);
        allSystemCalls.add(method.name);
        return run(method, work);
      });
      // Every runtime unit of work (`@Transactional()`, `inUnitOfWork`) goes through a host's
      // withTransaction; the system pool never does.
      const withTransaction = TransactionHost.prototype.withTransaction as (
        this: TransactionHost,
        ...args: unknown[]
      ) => unknown;
      vi.spyOn(TransactionHost.prototype, 'withTransaction').mockImplementation(function (
        this: TransactionHost,
        ...args: unknown[]
      ) {
        runtimeTransactions += 1;
        return withTransaction.apply(this, args);
      } as never);
      await db().superuser.execute(sql`truncate billing.payments, billing.stripe_events`);
      payA1 = makePayment({
        tenantId: TENANT_A,
        userId: A1,
        stripeCheckoutSessionId: 'cs_a1',
        amountTotal: 2_500,
        currency: 'usd',
      });
      payA2 = makePayment({ tenantId: TENANT_A, userId: A2 });
      payB1 = makePayment({
        tenantId: TENANT_B,
        userId: B1,
        stripeCheckoutSessionId: 'cs_b1',
        amountTotal: 2_500,
        currency: 'usd',
      });
      await db().superuser.insert(paymentsTable).values([payA1, payA2, payB1].map(toPaymentRow));
    });

    it('the app runs as app_runtime', async () => {
      const [row] = await db().db.execute<{ user: string }>(sql`select current_user as user`);
      expect(row).toEqual({ user: 'app_runtime' });
    });

    describe('Stripe webhook', () => {
      const ownedByA1 = { tenantId: TENANT_A, userId: A1 };

      it("a signed checkout.session.completed marks tenant A's payment succeeded and records the event under A", async () => {
        const webhook = completed('evt_a1_paid', { id: 'cs_a1', paymentId: payA1.id }, ownedByA1);

        await expect(deliver(webhook)).resolves.toEqual({
          received: true,
          eventId: 'evt_a1_paid',
          eventType: 'checkout.session.completed',
          duplicate: false,
        });

        expect(await paymentRow(payA1.id)).toMatchObject({ status: 'succeeded', version: 1 });
        expect(await eventRows()).toEqual([`${TENANT_A}/evt_a1_paid/${A1}`]);
        // One unit of work as the owner: markProcessed, load and save share it. No system method.
        expect(runtimeTransactions).toBeGreaterThan(0);
        expect(systemCalls).toEqual([]);
      });

      it('a replay changes nothing', async () => {
        const webhook = completed('evt_replay', { id: 'cs_a1', paymentId: payA1.id }, ownedByA1);
        await deliver(webhook);
        const [payments, events] = [await paymentRows(), await eventRows()];

        await expect(deliver(webhook)).resolves.toMatchObject({ duplicate: true });

        expect(await paymentRows()).toEqual(payments);
        expect(await eventRows()).toEqual(events);
        expect(systemCalls).toEqual([]);
      });

      it("metadata naming tenant A with tenant B's payment changes neither payment and is acknowledged", async () => {
        const webhook = completed('evt_cross', { id: 'cs_b1', paymentId: payB1.id }, ownedByA1);
        const before = await paymentRows();

        await expect(deliver(webhook)).resolves.toMatchObject({
          received: true,
          duplicate: false,
        });

        expect(await paymentRows()).toEqual(before);
        expect(await eventRows()).toEqual([`${TENANT_A}/evt_cross/${A1}`]);
        expect(systemCalls).toEqual([]);
      });

      it('a malformed tenant id never reaches SQL as a principal: recorded as a platform event', async () => {
        const webhook = completed(
          'evt_malformed',
          { id: 'cs_a1', paymentId: payA1.id },
          { tenantId: `${TENANT_A}' or '1'='1`, userId: A1 },
        );
        const before = await paymentRows();

        await expect(deliver(webhook)).resolves.toMatchObject({
          received: true,
          duplicate: false,
        });

        expect(await paymentRows()).toEqual(before);
        expect(await eventRows()).toEqual([`${PLATFORM_TENANT_ID}/evt_malformed/-`]);
        expect(systemCalls).toEqual([MARK_AS_PLATFORM]);
        // No runtime transaction was opened: no principal, no SET LOCAL, no payment lookup.
        expect(runtimeTransactions).toBe(0);
      });

      it('payout.paid is recorded with PLATFORM_TENANT_ID and a NULL user through the system method', async () => {
        const payout = signedEvent(
          'payout.paid',
          { id: 'po_1', object: 'payout' },
          { id: 'evt_payout' },
        );

        await expect(deliver(payout)).resolves.toEqual({
          received: true,
          eventId: 'evt_payout',
          eventType: 'payout.paid',
          duplicate: false,
        });
        await expect(deliver(payout)).resolves.toMatchObject({ duplicate: true });

        expect(await eventRows()).toEqual([`${PLATFORM_TENANT_ID}/evt_payout/-`]);
        expect(systemCalls).toEqual([MARK_AS_PLATFORM, MARK_AS_PLATFORM]);
        expect(runtimeTransactions).toBe(0);
      });

      it('a user-less owner of a real tenant is recorded under that tenant; no payment is touched', async () => {
        const webhook = completed(
          'evt_userless',
          { id: 'cs_a1', paymentId: payA1.id },
          { tenantId: TENANT_A },
        );
        const before = await paymentRows();

        await expect(deliver(webhook)).resolves.toMatchObject({ duplicate: false });

        expect(await paymentRows()).toEqual(before);
        expect(await eventRows()).toEqual([`${TENANT_A}/evt_userless/-`]);
        expect(systemCalls).toEqual([MARK_AS_PLATFORM]);
        expect(runtimeTransactions).toBe(0);
      });

      it('a failure after markProcessed rolls the event row back (Stripe retries it)', async () => {
        const webhook = completed('evt_retry', { id: 'cs_a1', paymentId: payA1.id }, ownedByA1);
        const save = vi
          .spyOn(repository, 'save')
          .mockRejectedValueOnce(new Error('connection reset'));

        await expect(deliver(webhook)).rejects.toThrow('connection reset');
        save.mockRestore();

        expect(await eventRows()).toEqual([]);
        expect(await paymentRow(payA1.id)).toMatchObject({ status: 'pending', version: 0 });

        await expect(deliver(webhook)).resolves.toMatchObject({ duplicate: false });
        expect(await paymentRow(payA1.id)).toMatchObject({ status: 'succeeded', version: 1 });
        expect(await eventRows()).toEqual([`${TENANT_A}/evt_retry/${A1}`]);
      });
    });

    describe('checkout and list payments, as the request principal', () => {
      it('create checkout session: the payment is written as the caller, the Stripe call outside every transaction', async () => {
        const contextAtStripe: unknown[] = [];
        // The fake Stripe gateway: records the RLS context it was called under (none expected).
        const gateway = vi
          .spyOn(stripe, 'createCheckoutSession')
          .mockImplementation(async (params) => {
            contextAtStripe.push(getAppliedRlsContext() ?? null);
            return makeCheckoutSession({
              id: 'cs_new',
              client_reference_id: params.clientReferenceId,
              amount_total: 1_000,
              currency: 'eur',
            });
          });

        const session: CheckoutSession = await as(a2, () =>
          commands.execute(
            new CreateCheckoutSessionCommand({
              tenantId: TENANT_A,
              userId: A2,
              customerEmail: 'a2@example.com',
              priceId: 'price_pro',
              quantity: 1,
            }),
          ),
        ).finally(() => gateway.mockRestore());

        expect(contextAtStripe).toEqual([null]);
        expect(await paymentRow(session.paymentId)).toMatchObject({
          tenant_id: TENANT_A,
          status: 'pending',
          version: 1,
        });
        const [bound] = await db().superuser.execute<{ user_id: string; session: string }>(sql`
          select user_id, stripe_checkout_session_id as session from billing.payments
          where id = ${session.paymentId}`);
        expect(bound).toEqual({ user_id: A2, session: 'cs_new' });
        expect(systemCalls).toEqual([]);
      });

      it('a member lists own payments only', async () => {
        const page: PaymentList = await as(a2, () =>
          queries.execute(new ListPaymentsQuery({ tenantId: TENANT_A, userId: A2, limit: 10 })),
        );
        expect(page.items.map((p) => p.id)).toEqual([payA2.id]);

        // The whole tenant needs billing:read-all: refused before any SQL.
        await expect(
          as(a2, () => queries.execute(new ListPaymentsQuery({ tenantId: TENANT_A, limit: 10 }))),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(systemCalls).toEqual([]);
      });

      it("an admin lists the tenant's payments (elevated), never tenant B's", async () => {
        const page: PaymentList = await as(a1, () =>
          queries.execute(new ListPaymentsQuery({ tenantId: TENANT_A, limit: 10 })),
        );
        expect(page.items.map((p) => p.id).sort()).toEqual([payA1.id, payA2.id].sort());
        expect(page.items.every((p) => p.tenantId === TENANT_A)).toBe(true);

        // Naming tenant B is refused before SQL; B's rows never come back.
        await expect(
          as(a1, () => queries.execute(new ListPaymentsQuery({ tenantId: TENANT_B, limit: 10 }))),
        ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
        // The elevation ends with its transaction: the admin's own list is own rows again.
        const own: PaymentList = await as(a1, () =>
          queries.execute(new ListPaymentsQuery({ tenantId: TENANT_A, userId: A1, limit: 10 })),
        );
        expect(own.items.map((p) => p.id)).toEqual([payA1.id]);
        expect(systemCalls).toEqual([]);
      });
    });

    describe('purge cron', () => {
      it('deletes the old events of every tenant through the system method', async () => {
        await db().superuser.execute(sql`
          insert into billing.stripe_events (tenant_id, id, user_id, type, processed_at) values
            (${TENANT_A}, 'evt_old_a', ${A1}, 't', now() - interval '40 days'),
            (${TENANT_B}, 'evt_old_b', ${B1}, 't', now() - interval '40 days'),
            (${PLATFORM_TENANT_ID}, 'evt_old_p', null, 't', now() - interval '40 days'),
            (${TENANT_A}, 'evt_new_a', ${A1}, 't', now()),
            (${PLATFORM_TENANT_ID}, 'evt_new_p', null, 't', now())`);

        // run() logs and swallows failures: the rows are the evidence.
        await db().app.get(PurgeStripeEventsCron, { strict: false }).run();

        expect((await eventRows()).sort()).toEqual(
          [`${TENANT_A}/evt_new_a/${A1}`, `${PLATFORM_TENANT_ID}/evt_new_p/-`].sort(),
        );
        expect(systemCalls).toEqual([DELETE_PROCESSED]);
        expect(runtimeTransactions).toBe(0);
      });
    });

    it('the flows used exactly the two named system methods', () => {
      expect([...allSystemCalls].sort()).toEqual([DELETE_PROCESSED, MARK_AS_PLATFORM]);
    });
  },
);
