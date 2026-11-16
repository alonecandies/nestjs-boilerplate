import { BILLING_SERVICE_NAME } from '@domain/billing-contracts';
import type { CommandBus, QueryBus } from '@nestjs/cqrs';
import { TEST_TENANT_ID } from '@platform/auth/testing';
import { DomainValidationException, generateId, PLATFORM_TENANT_ID } from '@platform/common';
import { createMock } from '@platform/testing';
import { ZodRpcValidationPipe } from '@platform/transport';
import { describe, expect, it } from 'vitest';
import { CreateCheckoutSessionCommand } from '../../application/commands/create-checkout-session/create-checkout-session.command.js';
import { HandleStripeWebhookCommand } from '../../application/commands/handle-stripe-webhook/handle-stripe-webhook.command.js';
import { ListPaymentsQuery } from '../../application/queries/list-payments/list-payments.query.js';
import { BillingGrpcController } from './billing-grpc.controller.js';
import {
  createCheckoutSessionRpcSchema,
  handleStripeWebhookRpcSchema,
  listPaymentsRpcSchema,
} from './billing-grpc.schemas.js';

const PATTERN_METADATA = 'microservices:pattern';

describe('BillingGrpcController', () => {
  const commandBus = createMock<CommandBus>();
  const queryBus = createMock<QueryBus>();
  const controller = new BillingGrpcController(
    commandBus as unknown as CommandBus,
    queryBus as unknown as QueryBus,
  );

  // ts-proto's decorator registers the lowerCamel method names; Nest matches them to the proto rpcs.
  it('registers the three BillingService methods', () => {
    const patterns = ['createCheckoutSession', 'handleStripeWebhook', 'listPayments'].map(
      (method) =>
        Reflect.getMetadata(
          PATTERN_METADATA,
          (controller as unknown as Record<string, object>)[method] as object,
        ) as unknown[],
    );
    expect(patterns).toEqual([
      [{ service: BILLING_SERVICE_NAME, rpc: 'createCheckoutSession', streaming: 'no_stream' }],
      [{ service: BILLING_SERVICE_NAME, rpc: 'handleStripeWebhook', streaming: 'no_stream' }],
      [{ service: BILLING_SERVICE_NAME, rpc: 'listPayments', streaming: 'no_stream' }],
    ]);
  });

  it('CreateCheckoutSession → CreateCheckoutSessionCommand', async () => {
    const session = { id: 'cs', url: 'https://x.test', paymentId: generateId() };
    commandBus.execute.mockResolvedValueOnce(session);
    const request = {
      tenantId: TEST_TENANT_ID,
      userId: generateId(),
      customerEmail: 'a@b.co',
      priceId: 'price',
      quantity: 1,
    };

    await expect(controller.createCheckoutSession(request)).resolves.toBe(session);
    const command = commandBus.execute.mock.calls.at(-1)?.[0] as CreateCheckoutSessionCommand;
    expect(command).toBeInstanceOf(CreateCheckoutSessionCommand);
    expect(command.request).toBe(request);
  });

  it('HandleStripeWebhook → HandleStripeWebhookCommand', async () => {
    commandBus.execute.mockResolvedValueOnce({ received: true });
    const payload = Buffer.from('{}');

    await controller.handleStripeWebhook({ payload, signature: 'sig' });

    const command = commandBus.execute.mock.calls.at(-1)?.[0] as HandleStripeWebhookCommand;
    expect(command).toBeInstanceOf(HandleStripeWebhookCommand);
    expect(command.payload).toBe(payload);
    expect(command.signature).toBe('sig');
  });

  it('ListPayments → ListPaymentsQuery', async () => {
    queryBus.execute.mockResolvedValueOnce({ items: [] });

    await controller.listPayments({ tenantId: TEST_TENANT_ID, limit: 0 });

    const query = queryBus.execute.mock.calls.at(-1)?.[0] as ListPaymentsQuery;
    expect(query).toBeInstanceOf(ListPaymentsQuery);
    expect(query.criteria).toEqual({ tenantId: TEST_TENANT_ID, userId: undefined, limit: 0 });
  });
});

describe('billing gRPC payload schemas (ZodRpcValidationPipe)', () => {
  it('normalises proto-loader nulls to undefined', () => {
    const pipe = new ZodRpcValidationPipe(createCheckoutSessionRpcSchema);
    const userId = generateId();

    expect(
      pipe.transform({
        tenantId: TEST_TENANT_ID,
        userId,
        customerEmail: 'a@b.co',
        priceId: ' price_1 ',
        quantity: 2,
        successUrl: null,
        cancelUrl: null,
        idempotencyKey: null,
      }),
    ).toEqual({
      tenantId: TEST_TENANT_ID,
      userId,
      customerEmail: 'a@b.co',
      priceId: 'price_1',
      quantity: 2,
      successUrl: undefined,
      cancelUrl: undefined,
      idempotencyKey: undefined,
    });
  });

  it('rejects invalid requests with INVALID_ARGUMENT-mapped issues', () => {
    const pipe = new ZodRpcValidationPipe(createCheckoutSessionRpcSchema);
    try {
      pipe.transform({
        tenantId: 'nope',
        userId: 'nope',
        customerEmail: 'x',
        priceId: '',
        quantity: 0,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainValidationException);
      expect((error as DomainValidationException).issues.map((i) => i.path)).toEqual(
        expect.arrayContaining(['tenantId', 'userId', 'customerEmail', 'priceId', 'quantity']),
      );
    }
  });

  it('wraps Uint8Array webhook payloads in a Buffer without copying', () => {
    const bytes = new TextEncoder().encode('{"id":"evt"}');
    const parsed = new ZodRpcValidationPipe(handleStripeWebhookRpcSchema).transform({
      payload: bytes,
      signature: 'sig',
    });

    expect(Buffer.isBuffer(parsed.payload)).toBe(true);
    expect(parsed.payload.buffer).toBe(bytes.buffer);
    expect(parsed.payload.toString('utf8')).toBe('{"id":"evt"}');
  });

  it('accepts an absent owner (every payment of the tenant) and bounds the limit', () => {
    const pipe = new ZodRpcValidationPipe(listPaymentsRpcSchema);
    expect(pipe.transform({ tenantId: TEST_TENANT_ID, userId: null, limit: 0 })).toEqual({
      tenantId: TEST_TENANT_ID,
      userId: undefined,
      limit: 0,
    });
    expect(() => pipe.transform({ tenantId: TEST_TENANT_ID, limit: 101 })).toThrow(
      DomainValidationException,
    );
  });

  it.each([undefined, null, '', 'acme', PLATFORM_TENANT_ID])(
    'requires a tenant UUID that is not the platform tenant (%j)',
    (tenantId) => {
      expect(() =>
        new ZodRpcValidationPipe(listPaymentsRpcSchema).transform({ tenantId, limit: 1 }),
      ).toThrow(DomainValidationException);
      expect(() =>
        new ZodRpcValidationPipe(createCheckoutSessionRpcSchema).transform({
          tenantId,
          userId: generateId(),
          customerEmail: 'a@b.co',
          priceId: 'price_1',
          quantity: 1,
        }),
      ).toThrow(DomainValidationException);
    },
  );
});
