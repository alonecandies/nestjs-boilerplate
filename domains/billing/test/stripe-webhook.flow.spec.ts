/*
 * The whole webhook path in-process, no infrastructure: Fastify raw body → BillingController →
 * BillingLocalAdapter → CommandBus → HandleStripeWebhookHandler (real signature verification,
 * @Transactional against the in-memory store) → EventBus → PaymentSucceededRelay → Kafka (fake).
 */

import { PAYMENT_SUCCEEDED_EVENT } from '@domain/billing-contracts';
import { CqrsModule } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { AuthModule, RbacModule } from '@platform/auth';
import { TEST_TENANT_ID } from '@platform/auth/testing';
import { provideCommonEnhancers } from '@platform/common';
import { AppConfigModule } from '@platform/config';
import { makeCounterProvider } from '@platform/observability';
import { createFastifyTestApp } from '@platform/testing';
import { KafkaProducer } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HandleStripeWebhookHandler } from '../src/application/commands/handle-stripe-webhook/handle-stripe-webhook.handler.js';
import { BillingPort } from '../src/application/ports/billing.port.js';
import { PaymentSucceededRelay } from '../src/application/relays/payment-succeeded.relay.js';
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
import { StripeService } from '../src/infrastructure/stripe/stripe.service.js';
import { BillingController } from '../src/presentation/http/billing.controller.js';
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
        RbacModule.forFeature(BILLING_RBAC),
        CqrsModule.forRoot(),
      ],
      controllers: [BillingController],
      providers: [
        { provide: BillingPort, useClass: BillingLocalAdapter },
        HandleStripeWebhookHandler,
        PaymentSucceededRelay,
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
    await vi.waitFor(() => expect(kafka.published(PAYMENT_SUCCEEDED_EVENT)).toHaveLength(1));
    expect(kafka.envelopes(PAYMENT_SUCCEEDED_EVENT)[0]?.payload).toMatchObject({
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
    expect(kafka.published(PAYMENT_SUCCEEDED_EVENT)).toHaveLength(1);
  });
});
