/*
 * The whole webhook path in-process, no infrastructure: Fastify raw body → BillingController →
 * BillingLocalAdapter → CommandBus → HandleStripeWebhookHandler (real signature verification,
 * @Transactional against the in-memory store) → billing's outbox (in memory, in the transaction)
 * → one OutboxRelay tick → Kafka (fake). Nothing reaches Kafka from the request path.
 */

import { PAYMENT_SUCCEEDED_EVENT } from '@domain/billing-contracts';
import { CqrsModule } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { AuthModule, RbacModule } from '@platform/auth';
import { TEST_TENANT_ID } from '@platform/auth/testing';
import { provideCommonEnhancers } from '@platform/common';
import type { OutboxConfig } from '@platform/config';
import { AppConfigModule } from '@platform/config';
import { makeCounterProvider } from '@platform/observability';
import { OutboxRelay } from '@platform/outbox';
import { createFastifyTestApp } from '@platform/testing';
import { KafkaProducer } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HandleStripeWebhookHandler } from '../src/application/commands/handle-stripe-webhook/handle-stripe-webhook.handler.js';
import { StripeOwnerResolver } from '../src/application/ledger/stripe-owner-resolver.js';
import { BillingPort } from '../src/application/ports/billing.port.js';
import { PaymentsRepository } from '../src/application/repositories/payments.repository.js';
import { StripeEventsRepository } from '../src/application/repositories/stripe-events.repository.js';
import { StripeEventsSystemRepository } from '../src/application/repositories/stripe-events.system-repository.js';
import {
  AMOUNT_MISMATCH_METRIC,
  API_VERSION_MISMATCH_METRIC,
  PAID_WITHOUT_AMOUNT_METRIC,
  PAID_WITHOUT_CURRENCY_METRIC,
} from '../src/billing.constants.js';
import { BILLING_RBAC } from '../src/billing.permissions.js';
import { PaymentStatus } from '../src/domain/payment-status.enum.js';
import { BillingLocalAdapter } from '../src/infrastructure/adapters/local/billing-local.adapter.js';
import { ledgerConfig } from '../src/infrastructure/ledger/ledger.config.js';
import { BILLING_OUTBOX, BillingOutbox } from '../src/infrastructure/persistence/billing-outbox.js';
import { BillingOutboxSystemRepository } from '../src/infrastructure/persistence/drizzle-outbox.system-repository.js';
import { StripeService } from '../src/infrastructure/stripe/stripe.service.js';
import { BillingController } from '../src/presentation/http/billing.controller.js';
import { createInMemoryBillingOutbox } from '../src/testing/in-memory-billing-outbox.js';
import { InMemoryStripeEventsSystemRepository } from '../src/testing/in-memory-stripe-events-system-repository.js';
import { FakeRedisModule } from './billing-http-test.utils.js';
import {
  createTestStripeService,
  InMemoryBillingStore,
  InMemoryPaymentsRepository,
  InMemoryStripeEventsRepository,
  installTestTransactionHost,
  makeCheckoutSession,
  makePayment,
  signedEvent,
} from './billing-test.utils.js';

/** `NestFastifyApplication`, typed through @platform/testing (billing does not depend on platform-fastify). */
type TestApp = Awaited<ReturnType<typeof createFastifyTestApp>>;

const WEBHOOK_URL = '/v1/billing/webhooks/stripe';

const RELAY: OutboxConfig = {
  relayEnabled: true,
  pollIntervalMs: 100,
  batchSize: 100,
  lockTtlMs: 1_000,
  maxBackoffMs: 1_000,
  retentionHours: 168,
};

describe('Stripe webhook flow (raw body → signature → exactly-once → outbox → relay → Kafka)', () => {
  const store = new InMemoryBillingStore();
  const kafka = new FakeKafkaProducer({ source: 'billing-flow-test' });
  // Enqueue refuses outside the webhook's transaction, like the real writer.
  const outbox = createInMemoryBillingOutbox({
    kafka,
    txHost: installTestTransactionHost(store).host,
  });
  const relay = new OutboxRelay(
    BILLING_OUTBOX,
    outbox,
    kafka,
    { using: () => Promise.reject(new Error('a tick takes no lock')) },
    RELAY,
    { systemPool: true },
  );
  const payment = makePayment({
    stripeCheckoutSessionId: 'cs_flow_1',
    amountTotal: 4_900,
    currency: 'eur',
  });
  let app: TestApp;

  const post = (payload: Buffer | string, signature?: string) =>
    app.inject({
      method: 'POST',
      url: WEBHOOK_URL,
      headers: {
        'content-type': 'application/json',
        ...(signature === undefined ? {} : { 'stripe-signature': signature }),
      },
      payload,
    });

  beforeAll(async () => {
    store.seed(payment);
    const builder = Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        FakeRedisModule,
        AuthModule.forRootAsync(),
        RbacModule.forFeature(BILLING_RBAC),
        CqrsModule.forRoot(),
      ],
      controllers: [BillingController],
      providers: [
        { provide: BillingPort, useClass: BillingLocalAdapter },
        HandleStripeWebhookHandler,
        StripeOwnerResolver,
        { provide: BillingOutbox, useValue: outbox },
        { provide: BillingOutboxSystemRepository, useValue: outbox },
        // LEDGER_ENABLED=false (the default): no ledger-posting rows in this flow.
        { provide: ledgerConfig.KEY, useValue: ledgerConfig.parse({}) },
        makeCounterProvider({ name: PAID_WITHOUT_CURRENCY_METRIC, help: 'test' }),
        makeCounterProvider({ name: AMOUNT_MISMATCH_METRIC, help: 'test' }),
        makeCounterProvider({ name: API_VERSION_MISMATCH_METRIC, help: 'test' }),
        makeCounterProvider({ name: PAID_WITHOUT_AMOUNT_METRIC, help: 'test' }),
        { provide: StripeService, useValue: createTestStripeService() },
        { provide: PaymentsRepository, useValue: new InMemoryPaymentsRepository(store) },
        { provide: StripeEventsRepository, useValue: new InMemoryStripeEventsRepository(store) },
        {
          provide: StripeEventsSystemRepository,
          useValue: new InMemoryStripeEventsSystemRepository(),
        },
        { provide: KafkaProducer, useValue: kafka },
        ...provideCommonEnhancers({ exposeInternalErrors: true }),
      ],
    });
    app = await createFastifyTestApp(builder, undefined, {
      appOptions: { rawBody: true, logger: false },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  const completed = signedEvent(
    'checkout.session.completed',
    makeCheckoutSession({
      id: 'cs_flow_1',
      client_reference_id: payment.id,
      payment_status: 'paid',
      amount_total: 4_900,
      currency: 'eur',
      metadata: { paymentId: payment.id, userId: payment.userId, tenantId: TEST_TENANT_ID },
    }),
    { id: 'evt_flow_completed' },
  );

  it('rejects a body that was re-serialised (signature covers the exact bytes)', async () => {
    const reserialised = JSON.stringify(JSON.parse(completed.payload.toString('utf8')), null, 2);

    const res = await post(reserialised, completed.signature);

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
    expect(store.state.events.size).toBe(0);
  });

  it('rejects a missing signature', async () => {
    const res = await post(completed.payload);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
  });

  it('applies a correctly signed event once, enqueues billing.payment-succeeded.v1, and a relay tick publishes it', async () => {
    const res = await post(completed.payload, completed.signature);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      received: true,
      eventId: 'evt_flow_completed',
      eventType: 'checkout.session.completed',
      duplicate: false,
    });
    expect(store.payment(payment.id)?.status).toBe(PaymentStatus.Succeeded);
    // The request path wrote one outbox row and published nothing.
    expect(outbox.unpublished().map((row) => [row.topic, row.tenantId, row.key])).toEqual([
      [PAYMENT_SUCCEEDED_EVENT.topic, TEST_TENANT_ID, payment.userId],
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(kafka.records).toEqual([]);

    await expect(relay.tick(new AbortController().signal)).resolves.toEqual({
      polled: 1,
      published: 1,
      failed: false,
    });
    expect(outbox.unpublished()).toEqual([]);
    expect(kafka.published(PAYMENT_SUCCEEDED_EVENT)).toHaveLength(1);
    expect(kafka.published(PAYMENT_SUCCEEDED_EVENT)[0]?.key).toBe(payment.userId);
    expect(kafka.envelopes(PAYMENT_SUCCEEDED_EVENT)[0]).toMatchObject({
      id: outbox.records[0]?.id,
      tenantId: TEST_TENANT_ID,
      actorId: payment.userId,
    });
    expect(kafka.envelopes(PAYMENT_SUCCEEDED_EVENT)[0]?.payload).toMatchObject({
      paymentId: payment.id,
      amountTotal: 4_900,
      currency: 'eur',
      stripeCheckoutSessionId: 'cs_flow_1',
    });
  });

  it('acknowledges Stripe’s redelivery as a duplicate (no second outbox row, no second Kafka event)', async () => {
    const res = await post(completed.payload, completed.signature);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ duplicate: true });
    expect(outbox.records).toHaveLength(1);
    await expect(relay.tick(new AbortController().signal)).resolves.toMatchObject({
      polled: 0,
      published: 0,
    });
    expect(kafka.published(PAYMENT_SUCCEEDED_EVENT)).toHaveLength(1);
  });
});
