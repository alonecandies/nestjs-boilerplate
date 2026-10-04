import {
  DomainConflictException,
  ExternalServiceException,
  generateId,
  isUuidV7,
} from '@app/common';
import type { CreateCheckoutSessionRequest } from '@app/contracts';
import type { StripeService } from '@app/payments';
import { createMock, type Mocked } from '@app/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryBillingStore,
  InMemoryPaymentsRepository,
  makeCheckoutSession,
  testStripeConfig,
} from '../../../../test/billing-test.utils.js';
import {
  CheckoutUrlMissingException,
  IdempotencyKeyReusedException,
} from '../../../domain/billing.errors.js';
import { PaymentStatus } from '../../../domain/payment-status.enum.js';
import { CreateCheckoutSessionCommand } from './create-checkout-session.command.js';
import {
  CreateCheckoutSessionHandler,
  checkoutIdempotencyKey,
} from './create-checkout-session.handler.js';

describe('CreateCheckoutSessionHandler', () => {
  let store: InMemoryBillingStore;
  let stripe: Mocked<StripeService>;
  let handler: CreateCheckoutSessionHandler;
  const userId = generateId();
  const request = (
    overrides: Partial<CreateCheckoutSessionRequest> = {},
  ): CreateCheckoutSessionRequest => ({
    userId,
    customerEmail: 'buyer@example.com',
    priceId: 'price_pro',
    quantity: 2,
    ...overrides,
  });

  beforeEach(() => {
    store = new InMemoryBillingStore();
    stripe = createMock<StripeService>();
    stripe.createCheckoutSession.mockResolvedValue(
      makeCheckoutSession({ id: 'cs_test_1', amount_total: 5_000, currency: 'usd' }),
    );
    handler = new CreateCheckoutSessionHandler(
      new InMemoryPaymentsRepository(store),
      stripe as unknown as StripeService,
      testStripeConfig,
    );
  });

  it('records a pending payment, creates the session keyed by the payment id and binds it', async () => {
    const result = await handler.execute(new CreateCheckoutSessionCommand(request()));

    expect(result).toEqual({
      id: 'cs_test_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test',
      paymentId: expect.any(String),
    });
    expect(isUuidV7(result.paymentId)).toBe(true);
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
      {
        customerEmail: 'buyer@example.com',
        priceId: 'price_pro',
        quantity: 2,
        successUrl: 'https://shop.test/billing/success',
        cancelUrl: 'https://shop.test/billing/cancel',
        clientReferenceId: result.paymentId,
        metadata: { paymentId: result.paymentId, userId },
      },
      checkoutIdempotencyKey(result.paymentId),
    );
    expect(store.payment(result.paymentId)).toMatchObject({
      userId,
      status: PaymentStatus.Pending,
      stripeCheckoutSessionId: 'cs_test_1',
      amountTotal: 5_000,
      currency: 'usd',
      version: 1,
    });
  });

  it('uses caller-provided redirect URLs (internal gRPC callers)', async () => {
    await handler.execute(
      new CreateCheckoutSessionCommand(
        request({ successUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/ko' }),
      ),
    );

    expect(stripe.createCheckoutSession.mock.calls[0]?.[0]).toMatchObject({
      successUrl: 'https://app.test/ok',
      cancelUrl: 'https://app.test/ko',
    });
  });

  it('replays an Idempotency-Key: same payment, same Stripe key, one row', async () => {
    const first = await handler.execute(
      new CreateCheckoutSessionCommand(request({ idempotencyKey: 'order-42-attempt' })),
    );
    const second = await handler.execute(
      new CreateCheckoutSessionCommand(request({ idempotencyKey: 'order-42-attempt' })),
    );

    expect(second).toEqual(first);
    expect(store.state.payments.size).toBe(1);
    expect(stripe.createCheckoutSession.mock.calls.map((call) => call[1])).toEqual([
      checkoutIdempotencyKey(first.paymentId),
      checkoutIdempotencyKey(first.paymentId),
    ]);
  });

  it('scopes Idempotency-Keys per user', async () => {
    const mine = await handler.execute(
      new CreateCheckoutSessionCommand(request({ idempotencyKey: 'shared-key-1' })),
    );
    const theirs = await handler.execute(
      new CreateCheckoutSessionCommand(
        request({ userId: generateId(), idempotencyKey: 'shared-key-1' }),
      ),
    );

    expect(theirs.paymentId).not.toBe(mine.paymentId);
    expect(store.state.payments.size).toBe(2);
  });

  it('rejects a replayed key with a different request before calling Stripe', async () => {
    await handler.execute(
      new CreateCheckoutSessionCommand(request({ idempotencyKey: 'order-43-key' })),
    );
    stripe.createCheckoutSession.mockClear();

    await expect(
      handler.execute(
        new CreateCheckoutSessionCommand(request({ idempotencyKey: 'order-43-key', quantity: 5 })),
      ),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedException);
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('marks the payment failed when Stripe fails, and a retry with the key reopens it', async () => {
    const stripeDown = new ExternalServiceException('Stripe is down', {
      code: 'PAYMENT_PROVIDER_ERROR',
    });
    stripe.createCheckoutSession.mockRejectedValueOnce(stripeDown);

    await expect(
      handler.execute(
        new CreateCheckoutSessionCommand(request({ idempotencyKey: 'order-44-key' })),
      ),
    ).rejects.toBe(stripeDown);
    const [failed] = [...store.state.payments.values()];
    expect(failed).toMatchObject({ status: PaymentStatus.Failed, stripeCheckoutSessionId: null });

    const retried = await handler.execute(
      new CreateCheckoutSessionCommand(request({ idempotencyKey: 'order-44-key' })),
    );
    expect(retried.paymentId).toBe(failed?.id);
    expect(store.payment(retried.paymentId)).toMatchObject({
      status: PaymentStatus.Pending,
      stripeCheckoutSessionId: 'cs_test_1',
    });
  });

  it('leaves the payment pending when Stripe reports the key in use (concurrent replay)', async () => {
    stripe.createCheckoutSession.mockRejectedValueOnce(
      new DomainConflictException('Idempotency key in use', { code: 'IDEMPOTENCY_KEY_REUSED' }),
    );

    await expect(
      handler.execute(
        new CreateCheckoutSessionCommand(request({ idempotencyKey: 'order-45-key' })),
      ),
    ).rejects.toBeInstanceOf(DomainConflictException);
    expect([...store.state.payments.values()][0]).toMatchObject({ status: PaymentStatus.Pending });
  });

  it('fails with 502 when Stripe returns no hosted URL (after binding the session)', async () => {
    stripe.createCheckoutSession.mockResolvedValueOnce(
      makeCheckoutSession({ id: 'cs_embedded', url: null }),
    );

    await expect(
      handler.execute(new CreateCheckoutSessionCommand(request())),
    ).rejects.toBeInstanceOf(CheckoutUrlMissingException);
    expect([...store.state.payments.values()][0]).toMatchObject({
      stripeCheckoutSessionId: 'cs_embedded',
    });
  });
});
