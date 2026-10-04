import { EntityNotFoundException, generateId } from '@app/common';
import { grpcConfig } from '@app/config';
import { type BillingServiceClient, type Payment } from '@app/contracts';
import { GRPC_METADATA_KEYS, GrpcCircuitBreakers } from '@app/transport';
import { Metadata, status } from '@grpc/grpc-js';
import type { ClientGrpc } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingGrpcAdapter, normalizePayment } from './billing-grpc.adapter.js';

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
    adapter = new BillingGrpcAdapter(grpc, grpcConfig.parse({ GRPC_DEADLINE_MS: '500' }), breakers);
    adapter.onModuleInit();
  });

  afterEach(() => breakers.onApplicationShutdown());

  it('sends the checkout request with the caller in metadata', async () => {
    const userId = generateId();
    client.createCheckoutSession.mockReturnValue(
      of({ id: 'cs_1', url: 'https://x.test', paymentId: 'p' }),
    );

    const request = { userId, customerEmail: 'a@b.co', priceId: 'price_1', quantity: 1 };
    await expect(adapter.createCheckoutSession(request)).resolves.toEqual({
      id: 'cs_1',
      url: 'https://x.test',
      paymentId: 'p',
    });

    const [sent, metadata] = client.createCheckoutSession.mock.calls[0] as [unknown, Metadata];
    expect(sent).toBe(request);
    expect(metadata).toBeInstanceOf(Metadata);
    expect(metadata.get(GRPC_METADATA_KEYS.USER_ID)).toEqual([userId]);
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

    const list = await adapter.listPayments({ limit: 5 });

    expect(client.listPayments.mock.calls[0]?.[0]).toEqual({ limit: 5 });
    expect(list.items[0]).toEqual({
      id: wire.id,
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

    await expect(adapter.listPayments({ limit: 1 })).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });

  it('keeps a present session id and fills a missing amount', () => {
    const payment = normalizePayment({
      id: 'p',
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
