import { DomainValidationException, ExternalServiceException } from '@app/common';
import { stripeConfig } from '@app/config';
import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { createStripeClient } from './stripe.module.js';
import { StripeService } from './stripe.service.js';

const WEBHOOK_SECRET = 'whsec_test_secret_for_unit_tests';
const cfg = stripeConfig.parse({
  STRIPE_SECRET_KEY: 'sk_test_unit',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
});

const event = {
  id: 'evt_test_1',
  object: 'event',
  type: 'checkout.session.completed',
  api_version: Stripe.API_VERSION,
  created: 1_700_000_000,
  livemode: false,
  pending_webhooks: 1,
  request: { id: null, idempotency_key: null },
  data: { object: { id: 'cs_test_1', object: 'checkout.session', client_reference_id: 'pay_1' } },
};
const payload = JSON.stringify(event);

function createService(): StripeService {
  return new StripeService(createStripeClient(cfg), cfg);
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the function to throw');
}

describe('StripeService.constructWebhookEvent', () => {
  it('accepts a correctly signed raw payload', () => {
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    const parsed = createService().constructWebhookEvent(Buffer.from(payload), header);

    expect(parsed.id).toBe('evt_test_1');
    expect(parsed.type).toBe('checkout.session.completed');
  });

  it('rejects a signature made with another secret', () => {
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_other' });

    const error = catchError(() =>
      createService().constructWebhookEvent(Buffer.from(payload), header),
    );

    expect(error).toBeInstanceOf(DomainValidationException);
    expect(error).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE', httpStatus: 422 });
    expect((error as Error).cause).toBeInstanceOf(Stripe.errors.StripeSignatureVerificationError);
  });

  it('rejects a stale timestamp (replay protection, 5 min tolerance)', () => {
    const header = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 600,
    });

    const error = catchError(() =>
      createService().constructWebhookEvent(Buffer.from(payload), header),
    );

    expect(error).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
  });

  it('rejects a re-serialized body (signature covers the exact bytes)', () => {
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const reserialized = JSON.stringify(JSON.parse(payload), null, 2);

    const error = catchError(() =>
      createService().constructWebhookEvent(Buffer.from(reserialized), header),
    );

    expect(error).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
  });

  it('rejects a missing signature header', () => {
    const error = catchError(() =>
      createService().constructWebhookEvent(Buffer.from(payload), undefined),
    );

    expect(error).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
  });

  it('rejects a correctly signed body that is not JSON', () => {
    const garbage = 'not-json';
    const header = Stripe.webhooks.generateTestHeaderString({
      payload: garbage,
      secret: WEBHOOK_SECRET,
    });

    const error = catchError(() =>
      createService().constructWebhookEvent(Buffer.from(garbage), header),
    );

    expect(error).toMatchObject({ code: 'INVALID_WEBHOOK_PAYLOAD' });
  });
});

describe('StripeService.createCheckoutSession', () => {
  const input = {
    customerEmail: 'jane@example.com',
    priceId: 'price_123',
    quantity: 2,
    successUrl: 'https://app.test/success?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://app.test/cancel',
    clientReferenceId: 'pay_1',
    metadata: { paymentId: 'pay_1', userId: 'user_1' },
  };

  it('creates a one-off payment session with the idempotency key as a request option', async () => {
    const service = createService();
    const create = vi
      .spyOn(service.client.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' } as never);

    const session = await service.createCheckoutSession(input, 'checkout-pay_1');

    expect(session.id).toBe('cs_1');
    expect(create).toHaveBeenCalledWith(
      {
        mode: 'payment',
        customer_email: 'jane@example.com',
        client_reference_id: 'pay_1',
        line_items: [{ price: 'price_123', quantity: 2 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: input.metadata,
        payment_intent_data: { metadata: input.metadata },
      },
      { idempotencyKey: 'checkout-pay_1' },
    );
  });

  it('passes no request options without an idempotency key', async () => {
    const service = createService();
    const create = vi
      .spyOn(service.client.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_2' } as never);

    await service.createCheckoutSession(input);

    expect(create.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('maps SDK errors to DomainExceptions', async () => {
    const service = createService();
    vi.spyOn(service.client.checkout.sessions, 'create').mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        message: "No such price: 'price_123'",
        param: 'line_items[0][price]',
        code: 'resource_missing',
        type: 'invalid_request_error',
      }),
    );

    await expect(service.createCheckoutSession(input)).rejects.toMatchObject({
      code: 'PAYMENT_REQUEST_INVALID',
      httpStatus: 422,
      message: "No such price: 'price_123'",
    });
  });

  it('hides upstream failures behind ExternalServiceException', async () => {
    const service = createService();
    vi.spyOn(service.client.checkout.sessions, 'create').mockRejectedValue(
      new Stripe.errors.StripeConnectionError({ message: 'socket hang up', type: 'api_error' }),
    );

    const promise = service.createCheckoutSession(input);

    await expect(promise).rejects.toBeInstanceOf(ExternalServiceException);
    await expect(promise).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' });
  });

  it('rethrows non-Stripe errors unchanged', async () => {
    const service = createService();
    const boom = new TypeError('boom');
    vi.spyOn(service.client.checkout.sessions, 'create').mockRejectedValue(boom);

    await expect(service.createCheckoutSession(input)).rejects.toBe(boom);
  });
});
