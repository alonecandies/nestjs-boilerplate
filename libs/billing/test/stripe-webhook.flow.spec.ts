/*
 * The whole webhook path in-process, no infrastructure: Fastify raw body → BillingController →
 * BillingLocalAdapter → CommandBus → HandleStripeWebhookHandler (real signature verification,
 * @Transactional against the in-memory store) → EventBus → PaymentSucceededRelay → Kafka (fake).
 */
import { AuthModule } from '@app/auth';
import { provideCommonEnhancers } from '@app/common';
import { AppConfigModule } from '@app/config';
import { KAFKA_TOPICS } from '@app/contracts';
import { makeCounterProvider } from '@app/observability';
import { StripeService } from '@app/payments';
import { createFastifyTestApp } from '@app/testing';
import { FakeKafkaProducer, KafkaProducer } from '@app/transport';
import { CqrsModule } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HandleStripeWebhookHandler } from '../src/application/commands/handle-stripe-webhook/handle-stripe-webhook.handler.js';
import { BillingPort } from '../src/application/ports/billing.port.js';
import { PaymentSucceededRelay } from '../src/application/relays/payment-succeeded.relay.js';
import { PaymentsRepository } from '../src/application/repositories/payments.repository.js';
import { StripeEventsRepository } from '../src/application/repositories/stripe-events.repository.js';
import { PAID_WITHOUT_CURRENCY_METRIC } from '../src/billing.constants.js';
import { PaymentStatus } from '../src/domain/payment-status.enum.js';
import { BillingLocalAdapter } from '../src/infrastructure/adapters/local/billing-local.adapter.js';
import { BillingController } from '../src/presentation/http/billing.controller.js';
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

/** `NestFastifyApplication`, typed through @app/testing (billing does not depend on platform-fastify). */
type TestApp = Awaited<ReturnType<typeof createFastifyTestApp>>;

const WEBHOOK_URL = '/v1/billing/webhooks/stripe';

describe('Stripe webhook flow (raw body → signature → exactly-once → Kafka)', () => {
  const store = new InMemoryBillingStore();
  const kafka = new FakeKafkaProducer({ source: 'billing-flow-test' });
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
    installTestTransactionHost(store);
    store.seed(payment);
    const builder = Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        FakeRedisModule,
        AuthModule.forRootAsync(),
        CqrsModule.forRoot(),
      ],
      controllers: [BillingController],
      providers: [
        { provide: BillingPort, useClass: BillingLocalAdapter },
        HandleStripeWebhookHandler,
        PaymentSucceededRelay,
        makeCounterProvider({ name: PAID_WITHOUT_CURRENCY_METRIC, help: 'test' }),
        { provide: StripeService, useValue: createTestStripeService() },
        { provide: PaymentsRepository, useValue: new InMemoryPaymentsRepository(store) },
        { provide: StripeEventsRepository, useValue: new InMemoryStripeEventsRepository(store) },
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

  it('applies a correctly signed event once and publishes billing.payment-succeeded.v1', async () => {
    const res = await post(completed.payload, completed.signature);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      received: true,
      eventId: 'evt_flow_completed',
      eventType: 'checkout.session.completed',
      duplicate: false,
    });
    expect(store.payment(payment.id)?.status).toBe(PaymentStatus.Succeeded);
    await vi.waitFor(() => expect(kafka.published(KAFKA_TOPICS.PAYMENT_SUCCEEDED)).toHaveLength(1));
    expect(kafka.envelopes(KAFKA_TOPICS.PAYMENT_SUCCEEDED)[0]?.payload).toMatchObject({
      paymentId: payment.id,
      amountTotal: 4_900,
      currency: 'eur',
      stripeCheckoutSessionId: 'cs_flow_1',
    });
  });

  it('acknowledges Stripe’s redelivery as a duplicate (no second Kafka event)', async () => {
    const res = await post(completed.payload, completed.signature);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ duplicate: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(kafka.published(KAFKA_TOPICS.PAYMENT_SUCCEEDED)).toHaveLength(1);
  });
});
