import type { CreateCheckoutSessionRequest } from '@domain/billing-contracts';
import { Logger } from '@nestjs/common';
import { TEST_TENANT_ID } from '@platform/auth/testing';
import {
  createPrincipal,
  DomainConflictException,
  ExternalServiceException,
  generateId,
  isUuidV7,
  runWithPrincipal,
} from '@platform/common';
import { createMock, type Mocked } from '@platform/testing';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
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
import type { StripeService } from '../../../infrastructure/stripe/stripe.service.js';
import { CreateCheckoutSessionCommand } from './create-checkout-session.command.js';
import {
  CreateCheckoutSessionHandler,
  checkoutIdempotencyKey,
} from './create-checkout-session.handler.js';

describe('CreateCheckoutSessionHandler', () => {
  let store: InMemoryBillingStore;
  let stripe: Mocked<StripeService>;
  let handler: CreateCheckoutSessionHandler;
  let withoutKey: { inc: Mock<() => void> };
  const userId = generateId();
  const principalOf = (user = userId, tenantId = TEST_TENANT_ID) =>
    createPrincipal({ userId: user, tenantId, roles: ['member'] });
  const principal = principalOf();
  const run = (r: CreateCheckoutSessionRequest, as = principal) =>
    runWithPrincipal(as, () => handler.execute(new CreateCheckoutSessionCommand(r)));
  const request = (
    overrides: Partial<CreateCheckoutSessionRequest> = {},
  ): CreateCheckoutSessionRequest => ({
    userId,
    tenantId: TEST_TENANT_ID,
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
    withoutKey = { inc: vi.fn<() => void>() };
    handler = new CreateCheckoutSessionHandler(
      new InMemoryPaymentsRepository(store),
      stripe as unknown as StripeService,
      testStripeConfig,
      withoutKey,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a pending payment, creates the session keyed by the payment id and binds it', async () => {
    const result = await run(request());

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
        metadata: { paymentId: result.paymentId, userId, tenantId: TEST_TENANT_ID },
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
    await run(request({ successUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/ko' }));

    expect(stripe.createCheckoutSession.mock.calls[0]?.[0]).toMatchObject({
      successUrl: 'https://app.test/ok',
      cancelUrl: 'https://app.test/ko',
    });
  });

  it('replays an Idempotency-Key: same payment, same Stripe key, one row', async () => {
    const first = await run(request({ idempotencyKey: 'order-42-attempt' }));
    stripe.retrieveCheckoutSession.mockResolvedValueOnce(
      makeCheckoutSession({
        id: 'cs_test_1',
        amount_total: 5_000,
        currency: 'usd',
        status: 'open',
      }),
    );
    const second = await run(request({ idempotencyKey: 'order-42-attempt' }));

    expect(second).toEqual(first);
    expect(store.state.payments.size).toBe(1);
    expect(stripe.createCheckoutSession.mock.calls.map((call) => call[1])).toEqual([
      checkoutIdempotencyKey(first.paymentId),
    ]);
    expect(stripe.retrieveCheckoutSession).toHaveBeenCalledWith('cs_test_1');
  });

  it('scopes Idempotency-Keys per user', async () => {
    const mine = await run(request({ idempotencyKey: 'shared-key-1' }));
    const theirId = generateId();
    const theirs = await run(
      request({ userId: theirId, idempotencyKey: 'shared-key-1' }),
      principalOf(theirId),
    );

    expect(theirs.paymentId).not.toBe(mine.paymentId);
    expect(store.state.payments.size).toBe(2);
  });

  it('rejects a replayed key with a different request before calling Stripe', async () => {
    await run(request({ idempotencyKey: 'order-43-key' }));
    stripe.createCheckoutSession.mockClear();

    await expect(
      run(request({ idempotencyKey: 'order-43-key', quantity: 5 })),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedException);
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('marks the payment failed when Stripe fails, and a retry with the key reopens it', async () => {
    const stripeDown = new ExternalServiceException('Stripe is down', {
      code: 'PAYMENT_PROVIDER_ERROR',
    });
    stripe.createCheckoutSession.mockRejectedValueOnce(stripeDown);

    await expect(run(request({ idempotencyKey: 'order-44-key' }))).rejects.toBe(stripeDown);
    const [failed] = [...store.state.payments.values()];
    expect(failed).toMatchObject({ status: PaymentStatus.Failed, stripeCheckoutSessionId: null });

    const retried = await run(request({ idempotencyKey: 'order-44-key' }));
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

    await expect(run(request({ idempotencyKey: 'order-45-key' }))).rejects.toBeInstanceOf(
      DomainConflictException,
    );
    expect([...store.state.payments.values()][0]).toMatchObject({ status: PaymentStatus.Pending });
  });

  it('fails with 502 when Stripe returns no hosted URL (after binding the session)', async () => {
    stripe.createCheckoutSession.mockResolvedValueOnce(
      makeCheckoutSession({ id: 'cs_embedded', url: null }),
    );

    await expect(run(request())).rejects.toBeInstanceOf(CheckoutUrlMissingException);
    expect([...store.state.payments.values()][0]).toMatchObject({
      stripeCheckoutSessionId: 'cs_embedded',
    });
  });

  it('a replay retrieves the bound session instead of creating a second one (S-1)', async () => {
    const first = await run(request({ idempotencyKey: 'order-50-key' }));
    stripe.createCheckoutSession.mockClear();
    stripe.retrieveCheckoutSession.mockResolvedValueOnce(
      makeCheckoutSession({
        id: 'cs_test_1',
        amount_total: 5_000,
        currency: 'usd',
        status: 'open',
      }),
    );
    const second = await run(request({ idempotencyKey: 'order-50-key' }));
    expect(second).toEqual(first);
    expect(stripe.retrieveCheckoutSession).toHaveBeenCalledWith('cs_test_1');
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it.each(['expired', 'complete'] as const)(
    'a replay of a %s session gets 409 CHECKOUT_SESSION_CLOSED and no new session',
    async (status) => {
      await run(request({ idempotencyKey: `order-51-${status}` }));
      stripe.createCheckoutSession.mockClear();
      stripe.retrieveCheckoutSession.mockResolvedValueOnce(
        makeCheckoutSession({ id: 'cs_test_1', status, url: null }),
      );
      await expect(run(request({ idempotencyKey: `order-51-${status}` }))).rejects.toMatchObject({
        code: 'CHECKOUT_SESSION_CLOSED',
        details: { sessionStatus: status },
      });
      expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    },
  );

  it('signs paymentId, userId and tenantId into the session metadata (B2-26, ledger D5)', async () => {
    const result = await run(request());

    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { paymentId: result.paymentId, userId, tenantId: TEST_TENANT_ID },
      }),
      checkoutIdempotencyKey(result.paymentId),
    );
    expect(store.payment(result.paymentId)).toMatchObject({ tenantId: TEST_TENANT_ID });
  });

  it('scopes the Idempotency-Key to the tenant: one key in two tenants makes two payments', async () => {
    const otherTenant = generateId();
    const first = await run(request({ idempotencyKey: 'order-42' }));
    const second = await run(
      request({ idempotencyKey: 'order-42', tenantId: otherTenant }),
      principalOf(userId, otherTenant),
    );

    expect(second.paymentId).not.toBe(first.paymentId);
    expect(store.payment(second.paymentId)).toMatchObject({ tenantId: otherTenant });
  });

  it('stores the request hash and 409s a replay whose URLs or email differ (ledger S-2)', async () => {
    const first = await run(request({ idempotencyKey: 'order-7' }));
    expect(store.payment(first.paymentId)?.requestHash).toMatch(/^[0-9a-f]{64}$/);

    await expect(
      run(request({ idempotencyKey: 'order-7', successUrl: 'https://evil.test/ok' })),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedException);
    stripe.retrieveCheckoutSession.mockResolvedValueOnce(
      makeCheckoutSession({
        id: 'cs_test_1',
        amount_total: 5_000,
        currency: 'usd',
        status: 'open',
      }),
    );
    await expect(run(request({ idempotencyKey: 'order-7' }))).resolves.toMatchObject({
      paymentId: first.paymentId,
    });
  });

  it('403 TENANT_MISMATCH when the request tenant is not the principal tenant', async () => {
    await expect(run(request({ tenantId: generateId() }))).rejects.toMatchObject({
      code: 'TENANT_MISMATCH',
    });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  describe('requests without an Idempotency-Key (S-4b)', () => {
    const debugSpy = () => vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    it('counts it once and logs one debug line with only userId and tenantId', async () => {
      const debug = debugSpy();

      const result = await run(request());

      expect(withoutKey.inc).toHaveBeenCalledExactlyOnceWith();
      expect(debug).toHaveBeenCalledExactlyOnceWith(
        { userId, tenantId: TEST_TENANT_ID },
        'Checkout request without an Idempotency-Key',
      );
      expect(result).toEqual({
        id: 'cs_test_1',
        url: 'https://checkout.stripe.com/c/pay/cs_test',
        paymentId: expect.any(String),
      });
      expect(store.payment(result.paymentId)).toMatchObject({
        idempotencyKey: null,
        status: PaymentStatus.Pending,
        stripeCheckoutSessionId: 'cs_test_1',
      });
    });

    it('neither counts nor logs a request that sends a key, and returns the same shape', async () => {
      const debug = debugSpy();

      const result = await run(request({ idempotencyKey: 'order-60-key' }));

      expect(withoutKey.inc).not.toHaveBeenCalled();
      expect(debug).not.toHaveBeenCalled();
      expect(result).toEqual({
        id: 'cs_test_1',
        url: 'https://checkout.stripe.com/c/pay/cs_test',
        paymentId: expect.any(String),
      });
      expect(store.payment(result.paymentId)).toMatchObject({ idempotencyKey: 'order-60-key' });
    });

    it('does not count a request refused for its tenant', async () => {
      await expect(run(request({ tenantId: generateId() }))).rejects.toMatchObject({
        code: 'TENANT_MISMATCH',
      });
      expect(withoutKey.inc).not.toHaveBeenCalled();
    });
  });
});
