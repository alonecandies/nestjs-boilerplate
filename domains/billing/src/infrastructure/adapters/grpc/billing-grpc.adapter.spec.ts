import type { BillingServiceClient, Payment } from '@domain/billing-contracts';
import { Metadata, status } from '@grpc/grpc-js';
import { Logger } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { TEST_TENANT_ID } from '@platform/auth/testing';
import {
  CLS_PRINCIPAL,
  createPrincipal,
  EntityNotFoundException,
  generateId,
  markTokenVerified,
  OperationTimeoutException,
  ServiceUnavailableException,
} from '@platform/common';
import { grpcConfig } from '@platform/config';
import { GRPC_METADATA_KEYS, GrpcCircuitBreakers } from '@platform/transport';
import { ClsServiceManager } from 'nestjs-cls';
import { defer, NEVER, type Observable, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingGrpcAdapter, normalizePayment } from './billing-grpc.adapter.js';
import {
  type BillingGrpcClientConfig,
  billingGrpcClientConfig,
} from './billing-grpc-client.config.js';

/** The Stripe-backed calls' deadline here: shorter than GRPC_DEADLINE_MS keeps the specs fast. */
const STRIPE_DEADLINE_MS = 100;
/** opossum's volume threshold (DEFAULT_GRPC_CIRCUIT_BREAKER_OPTIONS): calls before it may open. */
const BREAKER_VOLUME = 10;

/**
 * A cold upstream call that counts its subscriptions: the stub client builds the observable before
 * the breaker runs, so only a subscription means the call reached billing-service.
 */
function counted<T>(source: () => Observable<T>): { call: Observable<T>; reached: () => number } {
  let reached = 0;
  const call = defer(() => {
    reached += 1;
    return source();
  });
  return { call, reached: () => reached };
}

const checkoutRequest = () => ({
  tenantId: TEST_TENANT_ID,
  userId: generateId(),
  customerEmail: 'a@b.co',
  priceId: 'price_1',
  quantity: 1,
});

describe('BillingGrpcAdapter (port → billing.v1.BillingService)', () => {
  let client: { [K in keyof BillingServiceClient]: ReturnType<typeof vi.fn> };
  let breakers: GrpcCircuitBreakers;
  let adapter: BillingGrpcAdapter;

  beforeEach(() => {
    client = {
      createCheckoutSession: vi.fn(),
      handleStripeWebhook: vi.fn(),
      listPayments: vi.fn(),
    };
    const grpc: ClientGrpc = {
      getService: vi.fn(() => client),
      getClientByServiceName: vi.fn(),
    } as unknown as ClientGrpc;
    breakers = new GrpcCircuitBreakers();
    const billing: BillingGrpcClientConfig = {
      url: 'billing.test:50051',
      stripeDeadlineMs: STRIPE_DEADLINE_MS,
    };
    adapter = new BillingGrpcAdapter(
      grpc,
      grpcConfig.parse({ GRPC_DEADLINE_MS: '500' }),
      billing,
      breakers,
      ClsServiceManager.getClsService(),
    );
    adapter.onModuleInit();
  });

  afterEach(() => breakers.onApplicationShutdown());

  it('sends the checkout request with the caller in metadata', async () => {
    const userId = generateId();
    client.createCheckoutSession.mockReturnValue(
      of({ id: 'cs_1', url: 'https://x.test', paymentId: 'p' }),
    );

    const request = {
      tenantId: TEST_TENANT_ID,
      userId,
      customerEmail: 'a@b.co',
      priceId: 'price_1',
      quantity: 1,
    };
    // As the gateway calls it: inside a request whose principal its own token verification wrote.
    const cls = ClsServiceManager.getClsService();
    const checkout = cls.run(() => {
      cls.set(
        CLS_PRINCIPAL,
        markTokenVerified(createPrincipal({ userId, tenantId: TEST_TENANT_ID })),
      );
      return adapter.createCheckoutSession(request);
    });
    await expect(checkout).resolves.toEqual({
      id: 'cs_1',
      url: 'https://x.test',
      paymentId: 'p',
    });

    const [sent, metadata] = client.createCheckoutSession.mock.calls[0] as [unknown, Metadata];
    expect(sent).toBe(request);
    expect(metadata).toBeInstanceOf(Metadata);
    expect(metadata.get(GRPC_METADATA_KEYS.USER_ID)).toEqual([userId]);
    expect(metadata.get(GRPC_METADATA_KEYS.TENANT_ID)).toEqual([TEST_TENANT_ID]);
  });

  it('forwards the webhook bytes as-is', async () => {
    const payload = Buffer.from('{"raw":true}');
    client.handleStripeWebhook.mockReturnValue(
      of({ received: true, eventId: 'evt_1', eventType: 'x', duplicate: false }),
    );

    await adapter.handleStripeWebhook({ payload, signature: 'sig' });

    expect(client.handleStripeWebhook.mock.calls[0]?.[0]).toEqual({ payload, signature: 'sig' });
  });

  it('normalises proto-loader nulls in listed payments', async () => {
    const wire = {
      id: generateId(),
      tenantId: TEST_TENANT_ID,
      userId: generateId(),
      status: 'pending',
      amountTotal: '',
      currency: '',
      priceId: 'price_1',
      quantity: 1,
      stripeCheckoutSessionId: null,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: null,
    } as unknown as Payment;
    client.listPayments.mockReturnValue(of({ items: [wire] }));

    const list = await adapter.listPayments({ tenantId: TEST_TENANT_ID, limit: 5 });

    expect(client.listPayments.mock.calls[0]?.[0]).toEqual({ tenantId: TEST_TENANT_ID, limit: 5 });
    expect(list.items[0]).toEqual({
      id: wire.id,
      tenantId: TEST_TENANT_ID,
      userId: wire.userId,
      status: 'pending',
      amountTotal: '0',
      currency: '',
      priceId: 'price_1',
      quantity: 1,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: undefined,
    });
    expect(list.items[0]).not.toHaveProperty('stripeCheckoutSessionId');
  });

  it('maps upstream gRPC errors to the same DomainExceptions as the local adapter', async () => {
    const trailers = new Metadata();
    client.listPayments.mockReturnValue(
      throwError(() =>
        Object.assign(new Error('5 NOT_FOUND: Payment "x" was not found'), {
          code: status.NOT_FOUND,
          details: 'Payment "x" was not found',
          metadata: trailers,
        }),
      ),
    );

    await expect(
      adapter.listPayments({ tenantId: TEST_TENANT_ID, limit: 1 }),
    ).rejects.toBeInstanceOf(EntityNotFoundException);
  });

  it('slow Stripe-backed calls open billing-stripe, not the breaker ListPayments uses', async () => {
    const checkout = counted(() => NEVER);
    client.createCheckoutSession.mockReturnValue(checkout.call);
    const timedOut = await Promise.allSettled(
      Array.from({ length: BREAKER_VOLUME }, () =>
        adapter.createCheckoutSession(checkoutRequest()),
      ),
    );
    for (const result of timedOut) {
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(OperationTimeoutException);
    }

    // The next checkout fails fast without reaching billing-service.
    await expect(adapter.createCheckoutSession(checkoutRequest())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(checkout.reached()).toBe(BREAKER_VOLUME);

    const list = counted(() => of({ items: [] }));
    client.listPayments.mockReturnValue(list.call);
    await expect(adapter.listPayments({ tenantId: TEST_TENANT_ID, limit: 5 })).resolves.toEqual({
      items: [],
    });
    expect(list.reached()).toBe(1);
    expect(breakers.states()).toEqual({ 'billing-stripe': 'open', billing: 'closed' });
  });

  it('a failing ListPayments opens billing, not the breaker of the Stripe-backed calls', async () => {
    const list = counted(() =>
      throwError(() =>
        Object.assign(new Error('14 UNAVAILABLE: connection refused'), {
          code: status.UNAVAILABLE,
          details: 'connection refused',
          metadata: new Metadata(),
        }),
      ),
    );
    client.listPayments.mockReturnValue(list.call);
    const failed = await Promise.allSettled(
      Array.from({ length: BREAKER_VOLUME }, () =>
        adapter.listPayments({ tenantId: TEST_TENANT_ID, limit: 5 }),
      ),
    );
    expect(failed.every((result) => result.status === 'rejected')).toBe(true);
    await expect(
      adapter.listPayments({ tenantId: TEST_TENANT_ID, limit: 5 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(list.reached()).toBe(BREAKER_VOLUME);

    const checkout = counted(() => of({ id: 'cs_1', url: 'https://x.test', paymentId: 'p' }));
    client.createCheckoutSession.mockReturnValue(checkout.call);
    await expect(adapter.createCheckoutSession(checkoutRequest())).resolves.toMatchObject({
      id: 'cs_1',
    });
    const webhook = counted(() =>
      of({ received: true, eventId: 'evt_1', eventType: 'x', duplicate: false }),
    );
    client.handleStripeWebhook.mockReturnValue(webhook.call);
    await expect(
      adapter.handleStripeWebhook({ payload: Buffer.from('{}'), signature: 'sig' }),
    ).resolves.toMatchObject({ received: true });
    expect(checkout.reached()).toBe(1);
    expect(webhook.reached()).toBe(1);
    expect(breakers.states()).toEqual({ billing: 'open', 'billing-stripe': 'closed' });
  });

  it('keeps a present session id and fills a missing amount', () => {
    const payment = normalizePayment({
      id: 'p',
      tenantId: 't',
      userId: 'u',
      status: 'succeeded',
      amountTotal: '42',
      currency: 'usd',
      priceId: 'price',
      quantity: 2,
      stripeCheckoutSessionId: 'cs_1',
    });
    expect(payment).toMatchObject({ amountTotal: '42', stripeCheckoutSessionId: 'cs_1' });
  });
});

describe('BillingGrpcAdapter at module init: a Stripe deadline below GRPC_DEADLINE_MS', () => {
  const init = (env: { GRPC_DEADLINE_MS?: string; BILLING_GRPC_STRIPE_DEADLINE_MS?: string }) => {
    const breakers = new GrpcCircuitBreakers();
    const grpc = { getService: vi.fn(() => ({})) } as unknown as ClientGrpc;
    const adapter = new BillingGrpcAdapter(
      grpc,
      grpcConfig.parse(env),
      billingGrpcClientConfig.parse(env),
      breakers,
    );
    adapter.onModuleInit();
    breakers.onApplicationShutdown();
  };

  afterEach(() => vi.restoreAllMocks());

  it('logs one warning naming both variables and their values', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    init({ GRPC_DEADLINE_MS: '5000', BILLING_GRPC_STRIPE_DEADLINE_MS: '2000' });

    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain('BILLING_GRPC_STRIPE_DEADLINE_MS (2000)');
    expect(message).toContain('GRPC_DEADLINE_MS (5000)');
  });

  it('logs nothing with the defaults, or with the two deadlines equal', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    init({});
    init({ GRPC_DEADLINE_MS: '5000', BILLING_GRPC_STRIPE_DEADLINE_MS: '5000' });

    expect(warn).not.toHaveBeenCalled();
  });
});
