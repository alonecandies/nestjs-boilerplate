import { AuthModule } from '@app/auth';
import { DomainValidationException, generateId, provideCommonEnhancers } from '@app/common';
import { AppConfigModule } from '@app/config';
import type { Payment } from '@app/contracts';
import { createFastifyTestApp, createMock, type Mocked } from '@app/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeRedisModule,
  loginAs,
  Role,
  type TestPrincipal,
} from '../../../test/billing-http-test.utils.js';
import { BillingPort } from '../../application/ports/billing.port.js';
import { IdempotencyKeyReusedException } from '../../domain/billing.errors.js';
import { BillingController } from './billing.controller.js';

/** `NestFastifyApplication`, typed through @app/testing (billing does not depend on platform-fastify). */
type TestApp = Awaited<ReturnType<typeof createFastifyTestApp>>;

const CHECKOUT_URL = '/v1/billing/checkout-sessions';
const WEBHOOK_URL = '/v1/billing/webhooks/stripe';
const PAYMENTS_URL = '/v1/billing/payments';

describe('BillingController (Fastify, real guards, fake BillingPort)', () => {
  let app: TestApp;
  let port: Mocked<BillingPort>;
  let user: TestPrincipal;
  let admin: TestPrincipal;
  let moderator: TestPrincipal;

  beforeAll(async () => {
    port = createMock<BillingPort>();
    const builder = Test.createTestingModule({
      imports: [AppConfigModule.forRoot(), FakeRedisModule, AuthModule.forRootAsync()],
      controllers: [BillingController],
      providers: [
        { provide: BillingPort, useValue: port },
        ...provideCommonEnhancers({ exposeInternalErrors: true }),
      ],
    });
    app = await createFastifyTestApp(builder, undefined, {
      appOptions: { rawBody: true, logger: false },
    });
    [user, admin, moderator] = await Promise.all([
      loginAs(app, Role.User),
      loginAs(app, Role.Admin),
      loginAs(app, Role.Moderator),
    ]);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    port.createCheckoutSession.mockReset();
    port.handleStripeWebhook.mockReset();
    port.listPayments.mockReset();
  });

  describe('POST /v1/billing/checkout-sessions', () => {
    const session = {
      id: 'cs_test_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
      paymentId: generateId(),
    };

    it('401 without a token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: CHECKOUT_URL,
        payload: { priceId: 'price_1' },
      });

      expect(res.statusCode).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(port.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('403 without billing:checkout (moderator)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: CHECKOUT_URL,
        headers: { authorization: moderator.authorization },
        payload: { priceId: 'price_1' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    });

    it('201 for a user: body defaults applied, identity from the token, response serialised', async () => {
      port.createCheckoutSession.mockResolvedValue({
        ...session,
        internal: 'dropped',
      } as typeof session);

      const res = await app.inject({
        method: 'POST',
        url: CHECKOUT_URL,
        headers: { authorization: user.authorization },
        payload: { priceId: ' price_1 ' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(session);
      expect(port.createCheckoutSession).toHaveBeenCalledWith({
        userId: user.id,
        customerEmail: user.email,
        priceId: 'price_1',
        quantity: 1,
        idempotencyKey: undefined,
      });
    });

    it('forwards a valid Idempotency-Key', async () => {
      port.createCheckoutSession.mockResolvedValue(session);

      const res = await app.inject({
        method: 'POST',
        url: CHECKOUT_URL,
        headers: { authorization: user.authorization, 'idempotency-key': 'order-42:attempt-1' },
        payload: { priceId: 'price_1', quantity: 3 },
      });

      expect(res.statusCode).toBe(201);
      expect(port.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 3, idempotencyKey: 'order-42:attempt-1' }),
      );
    });

    it.each([
      [{ quantity: 1 }, 'priceId'],
      [{ priceId: 'price_1', quantity: 0 }, 'quantity'],
      [{ priceId: 'price_1', quantity: 1.5 }, 'quantity'],
      [{ priceId: 'price_1', quantity: 101 }, 'quantity'],
      [{ priceId: 'price_1', successUrl: 'https://evil.test' }, ''],
    ])('400 for invalid body %j', async (payload, path) => {
      const res = await app.inject({
        method: 'POST',
        url: CHECKOUT_URL,
        headers: { authorization: user.authorization },
        payload,
      });

      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json().errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ path })]),
      );
      expect(port.createCheckoutSession).not.toHaveBeenCalled();
    });

    it.each(['short', 'has spaces in it', 'x'.repeat(256)])(
      '400 for an invalid Idempotency-Key %#',
      async (key) => {
        const res = await app.inject({
          method: 'POST',
          url: CHECKOUT_URL,
          headers: { authorization: user.authorization, 'idempotency-key': key },
          payload: { priceId: 'price_1' },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json().errors[0]).toMatchObject({ path: 'headers.idempotency-key' });
      },
    );

    it('maps domain errors from the port to problem+json (409 IDEMPOTENCY_KEY_REUSED)', async () => {
      port.createCheckoutSession.mockRejectedValue(new IdempotencyKeyReusedException());

      const res = await app.inject({
        method: 'POST',
        url: CHECKOUT_URL,
        headers: { authorization: user.authorization, 'idempotency-key': 'order-42:attempt-1' },
        payload: { priceId: 'price_2' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
    });
  });

  describe('POST /v1/billing/webhooks/stripe (public, raw body)', () => {
    const ack = {
      received: true,
      eventId: 'evt_1',
      eventType: 'checkout.session.completed',
      duplicate: false,
    };

    it('hands the exact request bytes and the signature to the port — no token needed', async () => {
      port.handleStripeWebhook.mockResolvedValue(ack);
      // Formatting a JSON parser would not preserve (spacing, key order, escaped unicode).
      const raw =
        '{\n  "id": "evt_1",   "type": "checkout.session.completed", "note": "caf\\u00e9"\n}';

      const res = await app.inject({
        method: 'POST',
        url: WEBHOOK_URL,
        headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=abc' },
        payload: raw,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(ack);
      const [input] = port.handleStripeWebhook.mock.calls[0] ?? [];
      expect(Buffer.isBuffer(input?.payload)).toBe(true);
      expect(input?.payload.equals(Buffer.from(raw))).toBe(true);
      expect(input?.signature).toBe('t=1,v1=abc');
    });

    it('passes a missing signature as empty (the handler rejects it)', async () => {
      port.handleStripeWebhook.mockRejectedValue(
        new DomainValidationException('Missing webhook signature', {
          code: 'INVALID_WEBHOOK_SIGNATURE',
        }),
      );

      const res = await app.inject({
        method: 'POST',
        url: WEBHOOK_URL,
        headers: { 'content-type': 'application/json' },
        payload: '{"id":"evt_1"}',
      });

      expect(port.handleStripeWebhook.mock.calls[0]?.[0].signature).toBe('');
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
    });

    it('skips throttling', () => {
      const handler = Reflect.get(BillingController.prototype, 'handleStripeWebhook') as object;
      expect(Reflect.getMetadata('THROTTLER:SKIPdefault', handler)).toBe(true);
    });
  });

  describe('GET /v1/billing/payments', () => {
    const payment: Payment = {
      id: generateId(),
      userId: generateId(),
      status: 'succeeded',
      amountTotal: '2500',
      currency: 'usd',
      priceId: 'price_1',
      quantity: 1,
      stripeCheckoutSessionId: 'cs_1',
      createdAt: new Date('2026-09-01T10:00:00.000Z'),
      updatedAt: undefined,
    };

    it('401 without a token', async () => {
      const res = await app.inject({ method: 'GET', url: PAYMENTS_URL });
      expect(res.statusCode).toBe(401);
    });

    it("lists the caller's own payments with JSON-friendly fields", async () => {
      port.listPayments.mockResolvedValue({ items: [payment] });

      const res = await app.inject({
        method: 'GET',
        url: PAYMENTS_URL,
        headers: { authorization: user.authorization },
      });

      expect(res.statusCode).toBe(200);
      expect(port.listPayments).toHaveBeenCalledWith({ userId: user.id, limit: 20 });
      expect(res.json()).toEqual({
        items: [
          {
            id: payment.id,
            userId: payment.userId,
            status: 'succeeded',
            amountTotal: 2500,
            currency: 'usd',
            priceId: 'price_1',
            quantity: 1,
            stripeCheckoutSessionId: 'cs_1',
            createdAt: '2026-09-01T10:00:00.000Z',
            updatedAt: null,
          },
        ],
      });
    });

    it('403 for all=true without billing:read-all', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${PAYMENTS_URL}?all=true`,
        headers: { authorization: user.authorization },
      });

      expect(res.statusCode).toBe(403);
      expect(port.listPayments).not.toHaveBeenCalled();
    });

    it('all=true lists every user for an admin', async () => {
      port.listPayments.mockResolvedValue({ items: [] });

      const res = await app.inject({
        method: 'GET',
        url: `${PAYMENTS_URL}?all=true&limit=5`,
        headers: { authorization: admin.authorization },
      });

      expect(res.statusCode).toBe(200);
      expect(port.listPayments).toHaveBeenCalledWith({ userId: undefined, limit: 5 });
    });

    it.each(['limit=abc', 'limit=0', 'limit=1000', 'all=maybe'])('400 for ?%s', async (query) => {
      const res = await app.inject({
        method: 'GET',
        url: `${PAYMENTS_URL}?${query}`,
        headers: { authorization: user.authorization },
      });

      expect(res.statusCode).toBe(400);
      expect(port.listPayments).not.toHaveBeenCalled();
    });
  });

  it('documents every route in OpenAPI (zod schemas converted)', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());

    expect(document.paths[CHECKOUT_URL]?.post?.requestBody).toBeDefined();
    expect(document.paths[WEBHOOK_URL]?.post).toBeDefined();
    const parameters = (document.paths[PAYMENTS_URL]?.get?.parameters ?? []) as { name: string }[];
    expect(parameters.map((p) => p.name)).toEqual(expect.arrayContaining(['all', 'limit']));
    expect(Object.keys(document.components?.schemas ?? {})).toEqual(
      expect.arrayContaining([
        'CreateCheckoutSessionBody',
        'CheckoutSession',
        'Payment',
        'PaymentList',
      ]),
    );
  });
});
