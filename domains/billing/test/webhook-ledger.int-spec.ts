import { LEDGER_POSTING_REQUESTED_EVENT } from '@domain/billing-contracts';
import { Global, Module } from '@nestjs/common';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { RbacModule } from '@platform/auth';
import { parseEventEnvelope } from '@platform/contracts';
import { DistributedLockService } from '@platform/redis';
import { KafkaProducer } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { v5 as uuidv5 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HandleStripeWebhookCommand } from '../src/application/commands/handle-stripe-webhook/handle-stripe-webhook.command.js';
import { BILLING_RBAC } from '../src/billing.permissions.js';
import { BillingCoreModule } from '../src/billing-core.module.js';
import { LEDGER_NAMESPACE } from '../src/domain/ledger/ledger.types.js';
import type { Payment } from '../src/domain/payment.aggregate.js';
import { PaymentStatus } from '../src/domain/payment-status.enum.js';
import { payments as paymentsTable } from '../src/infrastructure/persistence/billing.schema.js';
import { toPaymentRow } from '../src/infrastructure/persistence/payment-row.mapper.js';
import { StripeService } from '../src/infrastructure/stripe/stripe.service.js';
import { type BillingDatabase, startBillingDatabase } from './billing-database.js';
import {
  makePayment,
  type SignedWebhook,
  signedEvent,
  TEST_WEBHOOK_SECRET,
} from './billing-test.utils.js';

/*
 * The ledger-posting row of a tenant money event (outbox plan Task 12, L-11) on Citus 14.2 (local
 * execution off): the real BillingCoreModule with LEDGER_ENABLED=true on the real DatabaseModule,
 * the webhook as app_runtime under the signed owner. The charges carry the signed metadata, so no
 * PaymentIntent GET is made (one would fail the spec); a refund's charge read is stubbed. Only Kafka and the lock are fakes; the module's
 * relay is off (OUTBOX_RELAY_ENABLED=false).
 * Opt-in (needs Docker): INTEGRATION=1 bunx vitest run --project billing:int webhook-ledger
 */

const TENANT_A = '0197c600-0000-7000-8000-0000000000a0';
const TENANT_B = '0197c600-0000-7000-8000-0000000000b0';
const A1 = '0197c600-0000-7000-8000-00000000a001';
const B1 = '0197c600-0000-7000-8000-00000000b001';
const CREATED = 1_790_000_000;
const POSTING = LEDGER_POSTING_REQUESTED_EVENT.topic;

const kafka = new FakeKafkaProducer({ source: 'billing-int' });

@Global()
@Module({
  providers: [
    { provide: KafkaProducer, useValue: kafka },
    {
      provide: DistributedLockService,
      useValue: { using: () => Promise.reject(new Error('the relay is disabled here')) },
    },
  ],
  exports: [KafkaProducer, DistributedLockService],
})
class FakeEdgesModule {}

/** The SQLSTATE of a database error, wherever the driver or ORM put it (`code` or a `cause`). */
function sqlStateOf(error: unknown): string | undefined {
  for (let at = error; typeof at === 'object' && at !== null; ) {
    const { code, cause } = at as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    at = cause;
  }
  return undefined;
}

type OutboxRowView = {
  tenant_id: string;
  id: string;
  topic: string;
  key: string | null;
  envelope: unknown;
};

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'money webhooks write the billing.ledger-posting.v1 row in the unit of the receipt (Citus)',
  () => {
    let database: BillingDatabase | undefined;
    let systemSql: Sql;
    let commands: CommandBus;
    let payA1: Payment;
    let payB1: Payment;

    const db = () => database ?? expect.fail('no database');
    const deliver = (webhook: SignedWebhook) =>
      commands.execute(new HandleStripeWebhookCommand(webhook.payload, webhook.signature));
    /** A charge event signed with `metadata` (tenant A's owner by default). */
    const chargeEvent = (
      type: 'charge.succeeded' | 'charge.refunded',
      eventId: string,
      metadata: Record<string, string>,
      overrides: Record<string, unknown> = {},
    ) =>
      signedEvent(
        type,
        {
          id: `ch_${eventId}`,
          object: 'charge',
          amount: 2_500,
          amount_refunded: 0,
          currency: 'usd',
          metadata,
          payment_intent: `pi_${eventId}`,
          ...overrides,
        },
        { id: eventId, created: CREATED },
      );
    const ownerA = (paymentId: string) => ({ tenantId: TENANT_A, userId: A1, paymentId });
    const postingRows = async (): Promise<OutboxRowView[]> => [
      ...(await db().superuser.execute<OutboxRowView>(sql`
        select tenant_id, id, topic, key, envelope from billing.outbox
        where topic = ${POSTING} order by created_at, id`)),
    ];
    const receipts = async (): Promise<string[]> =>
      (
        await db().superuser.execute<{ key: string }>(sql`
          select tenant_id || '/' || id as key from billing.stripe_events order by 1`)
      ).map((row) => row.key);
    const paymentStatus = async (id: string): Promise<string | undefined> =>
      (
        await db().superuser.execute<{ status: string }>(
          sql`select status from billing.payments where id = ${id}`,
        )
      )[0]?.status;

    beforeAll(async () => {
      vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_billing_ledger_int');
      vi.stubEnv('STRIPE_WEBHOOK_SECRET', TEST_WEBHOOK_SECRET);
      vi.stubEnv('OUTBOX_RELAY_ENABLED', 'false');
      vi.stubEnv('LEDGER_ENABLED', 'true');
      database = await startBillingDatabase([], {
        imports: [
          CqrsModule.forRoot(),
          RbacModule.forRoot(),
          RbacModule.forFeature(BILLING_RBAC),
          FakeEdgesModule,
          BillingCoreModule,
        ],
      });
      commands = database.app.get(CommandBus);
      systemSql = postgres(database.pg.systemUrl, { max: 1, onnotice: () => undefined });
      const succeeded = {
        status: PaymentStatus.Succeeded,
        amountTotal: 2_500,
        currency: 'usd',
        paidAt: new Date('2026-09-02T11:59:00.000Z'),
      };
      payA1 = makePayment({ tenantId: TENANT_A, userId: A1, ...succeeded });
      payB1 = makePayment({ tenantId: TENANT_B, userId: B1, ...succeeded });
      await db().superuser.insert(paymentsTable).values([payA1, payB1].map(toPaymentRow));
    }, 360_000);

    // In beforeEach: the config's restoreMocks undoes spies before every test.
    beforeEach(() => {
      // Every charge here carries its owner: a PaymentIntent GET would be a bug.
      vi.spyOn(StripeService.prototype, 'retrievePaymentIntent').mockRejectedValue(
        new Error('no Stripe call expected'),
      );
      // A refund event reads the charge's current refunded total: Stripe says refunded in full.
      vi.spyOn(StripeService.prototype, 'retrieveCharge').mockImplementation(
        async (id) => ({ id, object: 'charge', amount: 2_500, amount_refunded: 2_500 }) as never,
      );
    });

    afterAll(async () => {
      await systemSql?.end({ timeout: 5 });
      await database?.close();
    });

    it("charge.succeeded for tenant A commits the receipt and A's posting row together", async () => {
      await expect(
        deliver(chargeEvent('charge.succeeded', 'evt_ledger_a1', ownerA(payA1.id))),
      ).resolves.toMatchObject({ duplicate: false });

      expect(await receipts()).toEqual([`${TENANT_A}/evt_ledger_a1`]);
      const rows = await postingRows();
      expect(rows).toHaveLength(1);
      const id = uuidv5('evt_ledger_a1', LEDGER_NAMESPACE);
      expect(rows[0]).toMatchObject({ tenant_id: TENANT_A, id, topic: POSTING, key: TENANT_A });
      expect(parseEventEnvelope(LEDGER_POSTING_REQUESTED_EVENT, rows[0]?.envelope)).toMatchObject({
        id,
        tenantId: TENANT_A,
        actorId: A1,
        occurredAt: new Date(CREATED * 1_000).toISOString(),
        payload: {
          source: 'stripe',
          stripeEventId: 'evt_ledger_a1',
          stripeEventType: 'charge.succeeded',
          objectType: 'charge',
          objectId: 'ch_evt_ledger_a1',
          tenantId: TENANT_A,
          userId: A1,
          paymentId: payA1.id,
          livemode: false,
        },
      });
      expect(await paymentStatus(payA1.id)).toBe('succeeded');
      expect(kafka.records).toEqual([]);
    });

    it('a replay leaves one row', async () => {
      await expect(
        deliver(chargeEvent('charge.succeeded', 'evt_ledger_a1', ownerA(payA1.id))),
      ).resolves.toMatchObject({ duplicate: true });
      expect(await postingRows()).toHaveLength(1);
      expect(await receipts()).toEqual([`${TENANT_A}/evt_ledger_a1`]);
    });

    it('a forced outbox failure leaves neither the receipt nor the posting row', async () => {
      // The envelope id is deterministic: take it first on the app_system pool (its own commit),
      // so the webhook's own INSERT hits the primary key and its unit of work rolls back.
      const id = uuidv5('evt_ledger_forced', LEDGER_NAMESPACE);
      await systemSql`insert into billing.outbox (tenant_id, id, topic, key, envelope)
        values (${TENANT_A}, ${id}, ${POSTING}, ${TENANT_A}, ${systemSql.json({ seeded: true })})`;
      const event = chargeEvent('charge.succeeded', 'evt_ledger_forced', ownerA(payA1.id));

      const error = await deliver(event).then(
        () => expect.fail('the delivery should fail'),
        (failure: unknown) => failure,
      );
      expect(sqlStateOf(error)).toBe('23505');
      expect(await receipts()).toEqual([`${TENANT_A}/evt_ledger_a1`]);
      const forced = async () => (await postingRows()).filter((row) => row.id === id);
      expect(await forced()).toEqual([expect.objectContaining({ envelope: { seeded: true } })]);

      // Clear the seeded row: Stripe's redelivery then commits both.
      await systemSql`delete from billing.outbox where tenant_id = ${TENANT_A} and id = ${id}`;
      await expect(deliver(event)).resolves.toMatchObject({ duplicate: false });
      expect(await receipts()).toContain(`${TENANT_A}/evt_ledger_forced`);
      expect(await forced()).toEqual([
        expect.objectContaining({ tenant_id: TENANT_A, key: TENANT_A }),
      ]);
      expect((await forced())[0]?.envelope).toMatchObject({
        payload: { stripeEventId: 'evt_ledger_forced' },
      });
    });

    it("charge.refunded in full moves A's payment to refunded and writes no posting row", async () => {
      const before = (await postingRows()).length;
      await expect(
        deliver(
          chargeEvent('charge.refunded', 'evt_ledger_a1_rf', ownerA(payA1.id), {
            amount_refunded: 2_500,
          }),
        ),
      ).resolves.toMatchObject({ duplicate: false });
      expect(await paymentStatus(payA1.id)).toBe('refunded');
      expect(await postingRows()).toHaveLength(before);
    });

    it('metadata naming tenant A with a payment id of tenant B changes no payment of B', async () => {
      await expect(
        deliver(
          chargeEvent('charge.refunded', 'evt_ledger_cross_rf', ownerA(payB1.id), {
            amount_refunded: 2_500,
          }),
        ),
      ).resolves.toMatchObject({ duplicate: false });
      await expect(
        deliver(chargeEvent('charge.succeeded', 'evt_ledger_cross_ch', ownerA(payB1.id))),
      ).resolves.toMatchObject({ duplicate: false });

      expect(await paymentStatus(payB1.id)).toBe('succeeded');
      const [row] = (await postingRows()).filter(
        (candidate) => candidate.id === uuidv5('evt_ledger_cross_ch', LEDGER_NAMESPACE),
      );
      expect(row).toMatchObject({ tenant_id: TENANT_A });
      expect(
        parseEventEnvelope(LEDGER_POSTING_REQUESTED_EVENT, row?.envelope).payload,
      ).toMatchObject({ tenantId: TENANT_A, paymentId: null });
      expect(await receipts()).toContain(`${TENANT_A}/evt_ledger_cross_rf`);
    });
  },
);
