import { LEDGER_POSTING_REQUESTED_EVENT } from '@domain/billing-contracts';
import { Global, Module } from '@nestjs/common';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { RbacModule } from '@platform/auth';
import { PLATFORM_TENANT_ID } from '@platform/common';
import type { OutboxConfig } from '@platform/config';
import { parseEventEnvelope } from '@platform/contracts';
import { buildRlsContextSql } from '@platform/database';
import { OutboxRelay } from '@platform/outbox';
import { DistributedLockService } from '@platform/redis';
import { KafkaProducer } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { v5 as uuidv5 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HandleStripeWebhookCommand } from '../src/application/commands/handle-stripe-webhook/handle-stripe-webhook.command.js';
import { BILLING_RBAC } from '../src/billing.permissions.js';
import { BillingCoreModule } from '../src/billing-core.module.js';
import { LEDGER_NAMESPACE } from '../src/domain/ledger/ledger.types.js';
import { BILLING_OUTBOX } from '../src/infrastructure/persistence/billing-outbox.js';
import { BillingOutboxSystemRepository } from '../src/infrastructure/persistence/drizzle-outbox.system-repository.js';
import { StripeService } from '../src/infrastructure/stripe/stripe.service.js';
import { type BillingDatabase, startBillingDatabase } from './billing-database.js';
import { type SignedWebhook, signedEvent, TEST_WEBHOOK_SECRET } from './billing-test.utils.js';

/*
 * The platform path of a money webhook (outbox plan Task 12, L-11) on Citus 14.2 (local execution
 * off): `payout.paid` runs in SystemContext('billing.platform-webhook') and writes its
 * billing.ledger-posting.v1 row through outbox.insertAsPlatform (the nil tenant) before its receipt
 * through stripeEvents.markProcessedAsPlatform. The real BillingCoreModule with LEDGER_ENABLED=true;
 * the module's relay is off and the spec ticks one relay itself. Only Kafka and the lock are fakes.
 * Opt-in (needs Docker): INTEGRATION=1 bunx vitest run --project billing:int webhook-platform
 */

const TENANT_A = '0197c700-0000-7000-8000-0000000000a0';
const A1 = '0197c700-0000-7000-8000-00000000a001';
const CREATED = 1_790_000_000;
const POSTING = LEDGER_POSTING_REQUESTED_EVENT.topic;
const EVENT_ID = 'evt_platform_payout_1';

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

const RELAY: OutboxConfig = {
  relayEnabled: true,
  pollIntervalMs: 100,
  batchSize: 100,
  lockTtlMs: 1_000,
  maxBackoffMs: 1_000,
  retentionHours: 168,
};

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'payout.paid writes a platform ledger-posting row through the system pool (Citus)',
  () => {
    let database: BillingDatabase | undefined;
    let runtime: Sql;
    let commands: CommandBus;

    const db = () => database ?? expect.fail('no database');
    const deliver = (webhook: SignedWebhook) =>
      commands.execute(new HandleStripeWebhookCommand(webhook.payload, webhook.signature));
    const payout = signedEvent(
      'payout.paid',
      { id: 'po_platform_1', object: 'payout', amount: 10_000, currency: 'usd', metadata: {} },
      { id: EVENT_ID, created: CREATED },
    );
    const outboxRows = async () => [
      ...(await db().superuser.execute<{
        tenant_id: string;
        id: string;
        topic: string;
        key: string | null;
        envelope: unknown;
        published_at: string | null;
      }>(sql`select tenant_id, id, topic, key, envelope, published_at
        from billing.outbox order by created_at, id`)),
    ];

    beforeAll(async () => {
      vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_billing_platform_int');
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
      vi.spyOn(
        database.app.get(StripeService, { strict: false }),
        'retrievePaymentIntent',
      ).mockRejectedValue(new Error('a payout needs no Stripe call'));
      runtime = postgres(database.pg.runtimeUrl, { max: 1, onnotice: () => undefined });
    }, 360_000);

    afterAll(async () => {
      await runtime?.end({ timeout: 5 });
      await database?.close();
    });

    it('records the receipt and one nil-tenant posting row (key nil, actor and user null)', async () => {
      await expect(deliver(payout)).resolves.toMatchObject({ duplicate: false });

      const rows = await outboxRows();
      expect(rows).toHaveLength(1);
      const id = uuidv5(EVENT_ID, LEDGER_NAMESPACE);
      expect(rows[0]).toMatchObject({
        tenant_id: PLATFORM_TENANT_ID,
        id,
        topic: POSTING,
        key: PLATFORM_TENANT_ID,
        published_at: null,
      });
      expect(parseEventEnvelope(LEDGER_POSTING_REQUESTED_EVENT, rows[0]?.envelope)).toMatchObject({
        id,
        tenantId: PLATFORM_TENANT_ID,
        actorId: null,
        payload: {
          stripeEventId: EVENT_ID,
          stripeEventType: 'payout.paid',
          objectType: 'payout',
          objectId: 'po_platform_1',
          tenantId: PLATFORM_TENANT_ID,
          userId: null,
          paymentId: null,
        },
      });
      const receipts = await db().superuser.execute<{ tenant_id: string; user_id: string | null }>(
        sql`select tenant_id, user_id from billing.stripe_events where id = ${EVENT_ID}`,
      );
      expect([...receipts]).toEqual([{ tenant_id: PLATFORM_TENANT_ID, user_id: null }]);
    });

    it('a redelivery answers duplicate and adds no row', async () => {
      await expect(deliver(payout)).resolves.toMatchObject({ duplicate: true });
      expect(await outboxRows()).toHaveLength(1);
    });

    it.each([
      ['a member of tenant A', { elevated: false }],
      ['an elevated member of tenant A', { elevated: true }],
    ])('no runtime principal can read the payout row: %s', async (_label, { elevated }) => {
      const failure = await runtime
        .begin(async (tx) => {
          await tx.unsafe(buildRlsContextSql({ userId: A1, tenantId: TENANT_A })).simple();
          if (elevated) await tx.unsafe(`SET LOCAL app.elevated = 'on'`);
          return tx`select id from billing.outbox where tenant_id = ${PLATFORM_TENANT_ID}`;
        })
        .then(
          () => undefined,
          (error: unknown) => error as { code?: string; message: string },
        );
      expect(failure).toMatchObject({
        code: '42501',
        message: expect.stringMatching(/^permission denied for table outbox(_\d+)?$/),
      });
    });

    it('a relay tick publishes it with the nil tenant in the envelope', async () => {
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

      const [record] = published.published(LEDGER_POSTING_REQUESTED_EVENT);
      expect(record?.key).toBe(PLATFORM_TENANT_ID);
      expect(parseEventEnvelope(LEDGER_POSTING_REQUESTED_EVENT, record?.value)).toMatchObject({
        id: uuidv5(EVENT_ID, LEDGER_NAMESPACE),
        tenantId: PLATFORM_TENANT_ID,
        actorId: null,
        payload: { tenantId: PLATFORM_TENANT_ID, objectType: 'payout', userId: null },
      });
      const [row] = await outboxRows();
      expect(row?.published_at).not.toBeNull();
      expect(kafka.records).toEqual([]);
    });
  },
);
