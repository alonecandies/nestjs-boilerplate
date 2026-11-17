import { PAYMENT_SUCCEEDED_EVENT } from '@domain/billing-contracts';
import { Global, Module } from '@nestjs/common';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { RbacModule } from '@platform/auth';
import type { OutboxConfig } from '@platform/config';
import { parseEventEnvelope } from '@platform/contracts';
import { OutboxRelay } from '@platform/outbox';
import { DistributedLockService } from '@platform/redis';
import { KafkaProducer } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HandleStripeWebhookCommand } from '../src/application/commands/handle-stripe-webhook/handle-stripe-webhook.command.js';
import { PaymentsRepository } from '../src/application/repositories/payments.repository.js';
import { BILLING_RBAC } from '../src/billing.permissions.js';
import { BillingCoreModule } from '../src/billing-core.module.js';
import { PaymentSucceededEvent } from '../src/domain/events/payment-succeeded.event.js';
import type { Payment } from '../src/domain/payment.aggregate.js';
import { payments as paymentsTable } from '../src/infrastructure/persistence/billing.schema.js';
import { BILLING_OUTBOX } from '../src/infrastructure/persistence/billing-outbox.js';
import { BillingOutboxSystemRepository } from '../src/infrastructure/persistence/drizzle-outbox.system-repository.js';
import { toPaymentRow } from '../src/infrastructure/persistence/payment-row.mapper.js';
import { type BillingDatabase, startBillingDatabase } from './billing-database.js';
import {
  makeCheckoutSession,
  makePayment,
  type SignedWebhook,
  signedEvent,
  TEST_WEBHOOK_SECRET,
} from './billing-test.utils.js';

/*
 * billing.payment-succeeded.v1 on billing's outbox (outbox plan Task 6): the real BillingCoreModule
 * on the real DatabaseModule over Citus 14.2 (local execution off), migrated as app_owner, the
 * webhook running as app_runtime under the signed owner's principal, the relay's repository on
 * app_system. Only Kafka and the lock are fakes. The module's own relay is off
 * (OUTBOX_RELAY_ENABLED=false); the spec drives one relay tick itself.
 * Opt-in (needs Docker): INTEGRATION=1 bunx vitest run --project billing:int webhook-outbox
 */

const TENANT_A = '0197c400-0000-7000-8000-0000000000a0';
const A1 = '0197c400-0000-7000-8000-00000000a001';
const A2 = '0197c400-0000-7000-8000-00000000a002';

/** Whatever the request path publishes (it must stay empty). */
const kafka = new FakeKafkaProducer({ source: 'billing-int' });

/** Kafka and the relay's lock, faked: the module's relay is disabled and never asks for it. */
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

const RELAY: OutboxConfig = {
  relayEnabled: true,
  pollIntervalMs: 100,
  batchSize: 100,
  lockTtlMs: 1_000,
  maxBackoffMs: 1_000,
  retentionHours: 168,
};

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
  /** Raw `execute`: the timestamp text, or null while unpublished. */
  published_at: string | null;
};

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'the paid webhook enqueues billing.payment-succeeded.v1 in its unit of work (Citus)',
  () => {
    let database: BillingDatabase | undefined;
    let systemSql: Sql;
    let commands: CommandBus;
    let payA1: Payment;
    let payA2: Payment;

    const db = () => database ?? expect.fail('no database');
    const deliver = (webhook: SignedWebhook) =>
      commands.execute(new HandleStripeWebhookCommand(webhook.payload, webhook.signature));
    /** A paid `checkout.session.completed` signed for `payment`'s owner in tenant A. */
    const completed = (eventId: string, payment: Payment) =>
      signedEvent(
        'checkout.session.completed',
        makeCheckoutSession({
          id: payment.toSnapshot().stripeCheckoutSessionId ?? 'cs_unbound',
          client_reference_id: payment.id,
          payment_status: 'paid',
          payment_intent: `pi_${eventId}`,
          amount_total: 2_500,
          currency: 'usd',
          status: 'complete',
          metadata: { paymentId: payment.id, userId: payment.userId, tenantId: TENANT_A },
        }),
        { id: eventId, created: 1_790_000_000 },
      );
    const outboxRows = async (): Promise<OutboxRowView[]> => [
      ...(await db().superuser.execute<OutboxRowView>(sql`
        select tenant_id, id, topic, key, envelope, published_at
        from billing.outbox order by created_at, id`)),
    ];
    const paymentStatus = async (id: string): Promise<string | undefined> =>
      (
        await db().superuser.execute<{ status: string }>(
          sql`select status from billing.payments where id = ${id}`,
        )
      )[0]?.status;
    const receipts = async (): Promise<string[]> =>
      (
        await db().superuser.execute<{ key: string }>(sql`
          select tenant_id || '/' || id as key from billing.stripe_events order by 1`)
      ).map((row) => row.key);

    beforeAll(async () => {
      vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_billing_outbox_int');
      vi.stubEnv('STRIPE_WEBHOOK_SECRET', TEST_WEBHOOK_SECRET);
      vi.stubEnv('OUTBOX_RELAY_ENABLED', 'false');
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
      payA1 = makePayment({
        tenantId: TENANT_A,
        userId: A1,
        stripeCheckoutSessionId: 'cs_outbox_a1',
        amountTotal: 2_500,
        currency: 'usd',
      });
      payA2 = makePayment({
        tenantId: TENANT_A,
        userId: A2,
        stripeCheckoutSessionId: 'cs_outbox_a2',
        amountTotal: 2_500,
        currency: 'usd',
      });
      await db().superuser.insert(paymentsTable).values([payA1, payA2].map(toPaymentRow));
    }, 360_000);

    afterAll(async () => {
      await systemSql?.end({ timeout: 5 });
      await database?.close();
    });

    it("a signed checkout.session.completed for tenant A: payment succeeded, the receipt, and one outbox row with A's tenant_id", async () => {
      const webhook = completed('evt_outbox_a1_paid', payA1);
      await expect(deliver(webhook)).resolves.toMatchObject({ duplicate: false });

      expect(await paymentStatus(payA1.id)).toBe('succeeded');
      expect(await receipts()).toEqual([`${TENANT_A}/evt_outbox_a1_paid`]);
      const rows = await outboxRows();
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({
        tenant_id: TENANT_A,
        topic: PAYMENT_SUCCEEDED_EVENT.topic,
        key: A1,
        published_at: null,
      });
      expect(parseEventEnvelope(PAYMENT_SUCCEEDED_EVENT, row?.envelope)).toMatchObject({
        id: row?.id,
        tenantId: TENANT_A,
        actorId: A1,
        occurredAt: new Date(1_790_000_000 * 1_000).toISOString(),
        payload: { paymentId: payA1.id, userId: A1, amountTotal: 2_500, currency: 'usd' },
      });
      // Nothing went to Kafka from the request path.
      expect(kafka.records).toEqual([]);
    });

    it('a replay adds no row', async () => {
      const webhook = completed('evt_outbox_a1_paid', payA1);
      await expect(deliver(webhook)).resolves.toMatchObject({ duplicate: true });
      expect(await outboxRows()).toHaveLength(1);
      expect(await receipts()).toEqual([`${TENANT_A}/evt_outbox_a1_paid`]);
    });

    it('a relay tick publishes an envelope that parses with PAYMENT_SUCCEEDED_EVENT and marks the row', async () => {
      const published = new FakeKafkaProducer({ source: 'billing-int' });
      const relay = new OutboxRelay(
        BILLING_OUTBOX,
        db().app.get(BillingOutboxSystemRepository, { strict: false }),
        published,
        { using: () => Promise.reject(new Error('a tick takes no lock')) },
        RELAY,
        { systemPool: true },
      );

      await expect(relay.tick(new AbortController().signal)).resolves.toEqual({
        polled: 1,
        published: 1,
        failed: false,
      });

      const [row] = await outboxRows();
      const [record] = published.published(PAYMENT_SUCCEEDED_EVENT);
      expect(record?.key).toBe(A1);
      expect(parseEventEnvelope(PAYMENT_SUCCEEDED_EVENT, record?.value)).toMatchObject({
        id: row?.id,
        tenantId: TENANT_A,
        actorId: A1,
        payload: { paymentId: payA1.id, userId: A1, stripeCheckoutSessionId: 'cs_outbox_a1' },
      });
      expect(row?.published_at).not.toBeNull();
      expect(kafka.records).toEqual([]);
    });

    it("with the row's id pre-seeded through the system pool the delivery fails: payment pending, no receipt", async () => {
      // The envelope id is the PaymentSucceededEvent id, minted by complete() inside the unit of
      // work: seed it right after save, on the app_system pool (its own committed statement),
      // so the handler's enqueue then hits the primary key.
      const repository = db().app.get(PaymentsRepository, { strict: false });
      const save = repository.save.bind(repository);
      const seeded: string[] = [];
      const spy = vi.spyOn(repository, 'save').mockImplementationOnce(async (payment) => {
        await save(payment);
        const event = payment
          .getUncommittedEvents()
          .find((candidate) => candidate instanceof PaymentSucceededEvent);
        if (!(event instanceof PaymentSucceededEvent)) throw new Error('no PaymentSucceededEvent');
        seeded.push(event.eventId);
        await systemSql`insert into billing.outbox (tenant_id, id, topic, key, envelope)
          values (${TENANT_A}, ${event.eventId}, ${PAYMENT_SUCCEEDED_EVENT.topic}, ${A2},
            ${systemSql.json({ seeded: true })})`;
      });
      const before = (await outboxRows()).length;

      const error = await deliver(completed('evt_outbox_a2_paid', payA2)).then(
        () => expect.fail('the delivery should fail'),
        (failure: unknown) => failure,
      );
      expect(sqlStateOf(error)).toBe('23505');
      expect(spy).toHaveBeenCalledTimes(1);

      expect(await paymentStatus(payA2.id)).toBe('pending');
      expect(await receipts()).toEqual([`${TENANT_A}/evt_outbox_a1_paid`]);
      // Only the seeded row was added: the handler's own insert rolled back with the unit.
      const rows = await outboxRows();
      expect(rows).toHaveLength(before + 1);
      expect(rows.at(-1)).toMatchObject({ tenant_id: TENANT_A, id: seeded[0] });
      expect(rows.at(-1)?.envelope).toEqual({ seeded: true });
      expect(kafka.records).toEqual([]);
    });
  },
);
