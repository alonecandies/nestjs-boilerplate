import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  BILLING_GRPC_PACKAGE,
  BillingServiceControllerMethods,
  type CheckoutSession,
  type HandleStripeWebhookResponse,
  type PaymentList,
} from '@domain/billing-contracts';
import { Controller, type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { RbacModule } from '@platform/auth';
import { TEST_TENANT_ID } from '@platform/auth/testing';
import { generateId, OperationTimeoutException } from '@platform/common';
import { AppConfigModule, grpcConfig } from '@platform/config';
import { createGrpcServerStrategy } from '@platform/transport';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingPort } from '../../../application/ports/billing.port.js';
import { BillingApiModule } from '../../../billing-api.module.js';

/*
 * The gateway's deadlines over REAL gRPC (billing.v1 protos, loopback): BillingApiModule.forRemote()
 * against a grpc-js server (Nest's gRPC strategy) whose every handler answers after 600 ms.
 * GRPC_DEADLINE_MS=200 is below that, BILLING_GRPC_STRIPE_DEADLINE_MS=2000 above it: the
 * Stripe-backed calls must get the longer budget at both layers (the adapter's rxjs deadline and
 * the channel's service-config deadline, which grpc-js enforces on its own), and every other call
 * keeps GRPC_DEADLINE_MS.
 */

const ANSWER_AFTER_MS = 600;
const calls = { createCheckoutSession: 0, handleStripeWebhook: 0, listPayments: 0 };

@Controller()
@BillingServiceControllerMethods()
class SlowBillingService {
  async createCheckoutSession(): Promise<CheckoutSession> {
    calls.createCheckoutSession += 1;
    await sleep(ANSWER_AFTER_MS);
    return { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', paymentId: 'p_1' };
  }

  async handleStripeWebhook(): Promise<HandleStripeWebhookResponse> {
    calls.handleStripeWebhook += 1;
    await sleep(ANSWER_AFTER_MS);
    return { received: true, eventId: 'evt_1', eventType: 'x', duplicate: false };
  }

  async listPayments(): Promise<PaymentList> {
    calls.listPayments += 1;
    await sleep(ANSWER_AFTER_MS);
    return { items: [] };
  }
}

@Module({ controllers: [SlowBillingService] })
class SlowBillingServiceModule {}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('No free port');
  return address.port;
}

describe('billing over gRPC: the Stripe-backed calls get BILLING_GRPC_STRIPE_DEADLINE_MS', () => {
  let server: INestMicroservice;
  let gateway: TestingModule;
  let port: BillingPort;

  beforeAll(async () => {
    const grpcPort = await freePort();
    vi.stubEnv('BILLING_GRPC_URL', `127.0.0.1:${grpcPort}`);
    vi.stubEnv('GRPC_DEADLINE_MS', '200');
    vi.stubEnv('BILLING_GRPC_STRIPE_DEADLINE_MS', '2000');
    server = await NestFactory.createMicroservice(SlowBillingServiceModule, {
      ...createGrpcServerStrategy(grpcConfig.parse({ GRPC_URL: `127.0.0.1:${grpcPort}` }), [
        BILLING_GRPC_PACKAGE,
      ]),
      logger: false,
    });
    await server.listen();

    gateway = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot(), RbacModule.forRoot(), BillingApiModule.forRemote()],
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
    calls.createCheckoutSession = 0;
    calls.handleStripeWebhook = 0;
    calls.listPayments = 0;
  });

  it('CreateCheckoutSession outlives GRPC_DEADLINE_MS and reaches billing-service once', async () => {
    await expect(
      port.createCheckoutSession({
        tenantId: TEST_TENANT_ID,
        userId: generateId(),
        customerEmail: 'ada@example.com',
        priceId: 'price_1',
        quantity: 1,
      }),
    ).resolves.toEqual({
      id: 'cs_1',
      url: 'https://checkout.stripe.com/c/pay/cs_1',
      paymentId: 'p_1',
    });
    // Not in the package's idempotent methods: grpc-js never replays a checkout.
    expect(calls.createCheckoutSession).toBe(1);
  });

  it('HandleStripeWebhook outlives GRPC_DEADLINE_MS', async () => {
    await expect(
      port.handleStripeWebhook({ payload: Buffer.from('{}'), signature: 't=1,v1=abc' }),
    ).resolves.toEqual({ received: true, eventId: 'evt_1', eventType: 'x', duplicate: false });
    expect(calls.handleStripeWebhook).toBe(1);
  });

  it('ListPayments keeps GRPC_DEADLINE_MS: the gateway times out (504) first', async () => {
    const startedAt = performance.now();
    const error: unknown = await port
      .listPayments({ tenantId: TEST_TENANT_ID, limit: 5 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationTimeoutException);
    expect(error).toMatchObject({ httpStatus: 504 });
    expect(performance.now() - startedAt).toBeLessThan(ANSWER_AFTER_MS);
  });
});
