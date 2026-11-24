import { setTimeout as sleep } from 'node:timers/promises';
import {
  BILLING_GRPC_PACKAGE,
  BillingServiceControllerMethods,
  type CheckoutSession,
  type HandleStripeWebhookResponse,
  type PaymentList,
} from '@domain/billing-contracts';
import type { Metadata, ServerUnaryCall } from '@grpc/grpc-js';
import { Controller, type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { RbacModule } from '@platform/auth';
import { TEST_TENANT_ID } from '@platform/auth/testing';
import { generateId, OperationTimeoutException } from '@platform/common';
import { AppConfigModule, grpcConfig } from '@platform/config';
import { createGrpcServerStrategy } from '@platform/transport';
import { withBoundGrpcPort } from '@platform/transport/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingPort } from '../../../application/ports/billing.port.js';
import { BillingApiModule } from '../../../billing-api.module.js';

/*
 * The gateway's deadlines over REAL gRPC (billing.v1 protos, loopback): BillingApiModule.forRemote()
 * against a grpc-js server (Nest's gRPC strategy) whose every handler answers after 600 ms.
 * GRPC_DEADLINE_MS=200 is below that, BILLING_GRPC_STRIPE_DEADLINE_MS=2000 above it: the
 * Stripe-backed calls must get the longer budget at both layers (the adapter's rxjs deadline and
 * their own entries in the channel's service config, which grpc-js enforces on its own), and every
 * other call keeps GRPC_DEADLINE_MS at both layers: billing-service sees each call's deadline.
 */

const ANSWER_AFTER_MS = 600;
const GRPC_DEADLINE_MS = 200;
const STRIPE_DEADLINE_MS = 2000;
const calls = { createCheckoutSession: 0, handleStripeWebhook: 0, listPayments: 0 };
/** The time left until the call's deadline when billing-service's handler started (ms). */
const deadlineLeftMs: Partial<Record<keyof typeof calls, number>> = {};

type AnyServerCall = ServerUnaryCall<unknown, unknown>;

function recordDeadline(method: keyof typeof calls, call: AnyServerCall): void {
  const deadline = call.getDeadline();
  deadlineLeftMs[method] = (deadline instanceof Date ? deadline.getTime() : deadline) - Date.now();
}

@Controller()
@BillingServiceControllerMethods()
class SlowBillingService {
  async createCheckoutSession(
    _request: unknown,
    _metadata: Metadata,
    call: AnyServerCall,
  ): Promise<CheckoutSession> {
    recordDeadline('createCheckoutSession', call);
    calls.createCheckoutSession += 1;
    await sleep(ANSWER_AFTER_MS);
    return { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', paymentId: 'p_1' };
  }

  async handleStripeWebhook(
    _request: unknown,
    _metadata: Metadata,
    call: AnyServerCall,
  ): Promise<HandleStripeWebhookResponse> {
    recordDeadline('handleStripeWebhook', call);
    calls.handleStripeWebhook += 1;
    await sleep(ANSWER_AFTER_MS);
    return { received: true, eventId: 'evt_1', eventType: 'x', duplicate: false };
  }

  async listPayments(
    _request: unknown,
    _metadata: Metadata,
    call: AnyServerCall,
  ): Promise<PaymentList> {
    recordDeadline('listPayments', call);
    calls.listPayments += 1;
    await sleep(ANSWER_AFTER_MS);
    return { items: [] };
  }
}

@Module({ controllers: [SlowBillingService] })
class SlowBillingServiceModule {}

describe('billing over gRPC: the Stripe-backed calls get BILLING_GRPC_STRIPE_DEADLINE_MS', () => {
  let server: INestMicroservice;
  let gateway: TestingModule;
  let port: BillingPort;

  beforeAll(async () => {
    const { port: grpcPort } = await withBoundGrpcPort(async () => {
      server = await NestFactory.createMicroservice(SlowBillingServiceModule, {
        ...createGrpcServerStrategy(grpcConfig.parse({ GRPC_URL: '127.0.0.1:0' }), [
          BILLING_GRPC_PACKAGE,
        ]),
        logger: false,
      });
      await server.listen();
    });
    vi.stubEnv('BILLING_GRPC_URL', `127.0.0.1:${grpcPort}`);
    vi.stubEnv('GRPC_DEADLINE_MS', String(GRPC_DEADLINE_MS));
    vi.stubEnv('BILLING_GRPC_STRIPE_DEADLINE_MS', String(STRIPE_DEADLINE_MS));

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
    for (const method of Object.keys(calls) as (keyof typeof calls)[]) {
      delete deadlineLeftMs[method];
    }
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
    // billing-service sees the Stripe deadline (its own service-config entry), not the default.
    expect(deadlineLeftMs.createCheckoutSession).toBeGreaterThan(ANSWER_AFTER_MS);
    expect(deadlineLeftMs.createCheckoutSession).toBeLessThanOrEqual(STRIPE_DEADLINE_MS);
  });

  it('HandleStripeWebhook outlives GRPC_DEADLINE_MS', async () => {
    await expect(
      port.handleStripeWebhook({ payload: Buffer.from('{}'), signature: 't=1,v1=abc' }),
    ).resolves.toEqual({ received: true, eventId: 'evt_1', eventType: 'x', duplicate: false });
    expect(calls.handleStripeWebhook).toBe(1);
    expect(deadlineLeftMs.handleStripeWebhook).toBeGreaterThan(ANSWER_AFTER_MS);
    expect(deadlineLeftMs.handleStripeWebhook).toBeLessThanOrEqual(STRIPE_DEADLINE_MS);
  });

  it('ListPayments keeps GRPC_DEADLINE_MS at both layers: a 504 before billing-service answers', async () => {
    const startedAt = performance.now();
    const error: unknown = await port
      .listPayments({ tenantId: TEST_TENANT_ID, limit: 5 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationTimeoutException);
    expect(error).toMatchObject({ httpStatus: 504 });
    expect(performance.now() - startedAt).toBeLessThan(ANSWER_AFTER_MS);
    // billing-service sees GRPC_DEADLINE_MS too, not the Stripe deadline: the channel's default.
    expect(calls.listPayments).toBe(1);
    expect(deadlineLeftMs.listPayments).toBeGreaterThan(0);
    expect(deadlineLeftMs.listPayments).toBeLessThanOrEqual(GRPC_DEADLINE_MS);
  });
});
