import { createServer } from 'node:net';
import { DomainValidationException, generateId } from '@app/common';
import { AppConfigModule, grpcConfig } from '@app/config';
import { createGrpcServerStrategy } from '@app/transport';
import { type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePayment } from '../../../test/billing-test.utils.js';
import { CreateCheckoutSessionCommand } from '../../application/commands/create-checkout-session/create-checkout-session.command.js';
import { HandleStripeWebhookCommand } from '../../application/commands/handle-stripe-webhook/handle-stripe-webhook.command.js';
import { toPaymentListContract } from '../../application/mappers/payment.mapper.js';
import { BillingPort } from '../../application/ports/billing.port.js';
import { ListPaymentsQuery } from '../../application/queries/list-payments/list-payments.query.js';
import { BillingApiModule } from '../../billing-api.module.js';
import {
  IdempotencyKeyReusedException,
  PaymentNotFoundException,
} from '../../domain/billing.errors.js';
import { PaymentStatus } from '../../domain/payment-status.enum.js';
import { BillingGrpcAdapter } from '../../infrastructure/adapters/grpc/billing-grpc.adapter.js';
import { BillingGrpcController } from './billing-grpc.controller.js';

/*
 * The microservice topology in-process, over REAL gRPC (billing.v1 protos, loopback):
 *   gateway: BillingApiModule.forRemote() → BillingGrpcAdapter
 *     → grpc-js + proto-loader (defaults: true, longs: String) →
 *   billing-service: BillingGrpcController → (fake) CommandBus / QueryBus.
 * The buses answer with exactly what the LOCAL path returns (the real mappers), so each test
 * proves the remote adapter hands the presentation layer the same shape as the local adapter:
 * int64 as string, Timestamp → Date, absent optionals → undefined (not proto-loader's null),
 * raw webhook bytes untouched, and domain error codes surviving the hop.
 */

const commandBus = { execute: vi.fn() };
const queryBus = { execute: vi.fn() };

@Module({
  imports: [ClsModule.forRoot({ global: true })],
  controllers: [BillingGrpcController],
  providers: [
    { provide: CommandBus, useValue: commandBus },
    { provide: QueryBus, useValue: queryBus },
  ],
})
class BillingServiceTestModule {}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('No free port');
  return address.port;
}

describe('billing over gRPC (forRemote adapter ↔ BillingGrpcController)', () => {
  let server: INestMicroservice;
  let gateway: TestingModule;
  let port: BillingPort;

  beforeAll(async () => {
    const grpcPort = await freePort();
    vi.stubEnv('BILLING_GRPC_URL', `127.0.0.1:${grpcPort}`);
    vi.stubEnv('GRPC_DEADLINE_MS', '3000');
    server = await NestFactory.createMicroservice(BillingServiceTestModule, {
      ...createGrpcServerStrategy(grpcConfig.parse({ GRPC_URL: `127.0.0.1:${grpcPort}` }), [
        'billing',
      ]),
      logger: false,
    });
    await server.listen();

    gateway = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot(), BillingApiModule.forRemote()],
    }).compile();
    gateway.useLogger(false);
    await gateway.init();
    port = gateway.get(BillingPort);
  });

  afterAll(async () => {
    await gateway?.close();
    await server?.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    commandBus.execute.mockReset();
    queryBus.execute.mockReset();
  });

  it('forRemote() binds BillingPort to the gRPC adapter', () => {
    expect(port).toBeInstanceOf(BillingGrpcAdapter);
  });

  it('ListPayments: same shape as the local path (int64 string, Date, absent optionals)', async () => {
    const userId = generateId();
    const local = toPaymentListContract({
      items: [
        makePayment({ userId }), // pending: no amount, no currency, no checkout session yet
        makePayment({
          userId,
          status: PaymentStatus.Succeeded,
          amountTotal: 9_007_199_254,
          currency: 'jpy',
          stripeCheckoutSessionId: 'cs_test_1',
          paidAt: new Date('2026-09-02T00:00:00.000Z'),
        }),
      ],
      nextCursor: null,
    });
    queryBus.execute.mockResolvedValue(local);

    const remote = await port.listPayments({ userId, limit: 5 });

    expect(remote).toEqual(local);
    const [pending, paid] = remote.items;
    expect(pending?.stripeCheckoutSessionId).toBeUndefined();
    expect(pending?.amountTotal).toBe('0');
    expect(paid).toMatchObject({ amountTotal: '9007199254', stripeCheckoutSessionId: 'cs_test_1' });
    expect(paid?.createdAt).toBeInstanceOf(Date);
    expect(queryBus.execute).toHaveBeenCalledWith(new ListPaymentsQuery({ userId, limit: 5 }));
  });

  it('ListPayments without user id (admin "all") arrives as undefined, not null', async () => {
    queryBus.execute.mockResolvedValue({ items: [] });

    const list = await port.listPayments({ limit: 0 });
    expect(list).toEqual({ items: [] });
    // An absent next_cursor must not come back as null/"" (the port omits it).
    expect(list).not.toHaveProperty('nextCursor');
    const [query] = queryBus.execute.mock.calls[0] as [ListPaymentsQuery];
    expect(query).toBeInstanceOf(ListPaymentsQuery);
    // `toEqual` treats null and undefined differently: proto-loader's null must not leak through.
    expect(query.criteria.userId).toBeUndefined();
    expect(query.criteria.cursor).toBeUndefined();
    expect(query.criteria.limit).toBe(0);
  });

  it('ListPayments pages over gRPC: cursor in, next_cursor out', async () => {
    const userId = generateId();
    queryBus.execute.mockResolvedValue({ items: [], nextCursor: 'cursor-2' });

    await expect(port.listPayments({ userId, limit: 2, cursor: 'cursor-1' })).resolves.toEqual({
      items: [],
      nextCursor: 'cursor-2',
    });
    const [query] = queryBus.execute.mock.calls[0] as [ListPaymentsQuery];
    expect(query.criteria).toEqual({ userId, limit: 2, cursor: 'cursor-1' });
  });

  it('CreateCheckoutSession: absent optional fields reach the command as undefined', async () => {
    const session = {
      id: 'cs_1',
      url: 'https://checkout.stripe.com/c/pay/cs_1',
      paymentId: generateId(),
    };
    commandBus.execute.mockResolvedValue(session);
    const request = {
      userId: generateId(),
      customerEmail: 'ada@example.com',
      priceId: 'price_1',
      quantity: 2,
    };

    await expect(port.createCheckoutSession(request)).resolves.toEqual(session);
    const [command] = commandBus.execute.mock.calls[0] as [CreateCheckoutSessionCommand];
    expect(command).toBeInstanceOf(CreateCheckoutSessionCommand);
    expect(command.request).toMatchObject(request);
    for (const key of ['successUrl', 'cancelUrl', 'idempotencyKey'] as const) {
      expect(command.request[key]).toBeUndefined();
    }
  });

  it('HandleStripeWebhook: the raw bytes travel untouched (signature is over them)', async () => {
    const payload = Buffer.from([0x7b, 0x22, 0xff, 0x00, 0xfe, 0x22, 0x7d]); // not valid UTF-8
    const response = {
      received: true,
      eventId: 'evt_1',
      eventType: 'checkout.session.completed',
      duplicate: false,
    };
    commandBus.execute.mockResolvedValue(response);

    await expect(port.handleStripeWebhook({ payload, signature: 't=1,v1=abc' })).resolves.toEqual(
      response,
    );
    const [command] = commandBus.execute.mock.calls[0] as [HandleStripeWebhookCommand];
    expect(command).toBeInstanceOf(HandleStripeWebhookCommand);
    expect(Buffer.isBuffer(command.payload)).toBe(true);
    expect(command.payload.equals(payload)).toBe(true);
    expect(command.signature).toBe('t=1,v1=abc');
  });

  it('domain errors keep their status and code across the hop', async () => {
    const paymentId = generateId();
    queryBus.execute.mockRejectedValueOnce(new PaymentNotFoundException(paymentId));
    await expect(port.listPayments({ limit: 1 })).rejects.toMatchObject({
      httpStatus: 404,
      code: 'PAYMENT_NOT_FOUND',
    });

    commandBus.execute.mockRejectedValueOnce(new IdempotencyKeyReusedException());
    await expect(
      port.createCheckoutSession({
        userId: generateId(),
        customerEmail: 'ada@example.com',
        priceId: 'price_1',
        quantity: 1,
        idempotencyKey: 'order-7-attempt',
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('an invalid payload is rejected by the zod pipe (INVALID_ARGUMENT) before the bus', async () => {
    const error = await port
      .createCheckoutSession({ userId: 'not-a-uuid', customerEmail: 'x', priceId: '', quantity: 0 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainValidationException);
    expect(commandBus.execute).not.toHaveBeenCalled();
  });
});
