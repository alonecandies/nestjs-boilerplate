import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { KafkaContext } from '@nestjs/microservices';
import { CLS_PRINCIPAL, createPrincipal, generateId, PLATFORM_TENANT_ID } from '@platform/common';
import { defineEventContract } from '@platform/contracts';
import { ClsService } from 'nestjs-cls';
import { defer, lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { callerContextFromCls } from '../grpc/grpc-caller-context.js';
import { configurePrincipalAssertions } from '../grpc/grpc-principal-assertion.js';
import { createTestPrincipalSigner } from '../testing/test-principal-signer.js';
import { KafkaContextInterceptor } from './kafka-context.interceptor.js';
import { type KafkaEventEmitter, KafkaProducer } from './kafka-producer.service.js';

const ORDER_PLACED = defineEventContract(
  'orders.order-placed.v1',
  z.object({ orderId: z.uuid() }),
  {
    tenantScoped: true,
  },
);
const client: KafkaEventEmitter = { emit: () => of(undefined), connect: async () => undefined };
const userId = generateId();
const tenantId = generateId();

function kafkaContext(data: unknown): ExecutionContext {
  const message = { key: 'k', value: data, headers: {}, offset: '1' };
  const kafka = new KafkaContext([
    message as never,
    0,
    ORDER_PLACED.topic,
    {} as never,
    () => Promise.resolve(),
    {} as never,
  ]);
  return {
    getType: () => 'rpc',
    switchToRpc: () => ({ getContext: () => kafka, getData: () => data }),
  } as unknown as ExecutionContext;
}

describe('KafkaProducer fills tenantId/actorId from the CLS principal', () => {
  const cls = new ClsService(new AsyncLocalStorage());
  const producer = new KafkaProducer(client, { source: 'orders-service' }, cls);
  const body = { orderId: generateId() };

  it('uses the principal by default', () => {
    cls.run(() => {
      cls.set(CLS_PRINCIPAL, createPrincipal({ userId, tenantId, roles: ['member'] }));
      expect(producer.createEnvelope(ORDER_PLACED, body)).toMatchObject({
        tenantId,
        actorId: userId,
      });
    });
  });

  it('explicit options win, and actorId: null means no actor', () => {
    const other = generateId();
    cls.run(() => {
      cls.set(CLS_PRINCIPAL, createPrincipal({ userId, tenantId, roles: ['member'] }));
      expect(
        producer.createEnvelope(ORDER_PLACED, body, { tenantId: other, actorId: null }),
      ).toMatchObject({
        tenantId: other,
        actorId: null,
      });
    });
  });

  it('INVALID_EVENT for a tenant-scoped event outside any principal and without options', () => {
    expect(() => producer.createEnvelope(ORDER_PLACED, body)).toThrow(
      expect.objectContaining({ code: 'INVALID_EVENT' }),
    );
  });
});

describe('KafkaContextInterceptor restores the actor principal', () => {
  const cls = new ClsService(new AsyncLocalStorage());
  const interceptor = new KafkaContextInterceptor(cls);
  const seen = (data: unknown) => {
    const next: CallHandler = { handle: () => defer(() => of(cls.get<unknown>(CLS_PRINCIPAL))) };
    return lastValueFrom(interceptor.intercept(kafkaContext(data), next));
  };
  const envelope = (extra: Record<string, unknown>) => ({
    id: generateId(),
    payload: {},
    ...extra,
  });

  it('{ userId: actorId, tenantId } with no roles', async () => {
    await expect(seen(envelope({ tenantId, actorId: userId }))).resolves.toEqual({
      userId,
      tenantId,
      roles: [],
      staff: false,
    });
  });

  it.each([
    ['a legacy envelope', {}],
    ['a null actor', { tenantId, actorId: null }],
    ['the platform tenant', { tenantId: PLATFORM_TENANT_ID, actorId: userId }],
    ['a malformed tenant', { tenantId: 'acme', actorId: userId }],
  ])('no principal for %s', async (_label, extra) => {
    await expect(seen(envelope(extra))).resolves.toBeUndefined();
  });

  it('the actor is never signed into a gRPC principal assertion, even where a key is held', async () => {
    // Anyone who can produce to Kafka writes actorId: a consumer in the edge process (which holds
    // the signing key) must not turn it into a principal the services accept as verified.
    const signer = createTestPrincipalSigner();
    configurePrincipalAssertions({
      mode: 'off',
      signingKey: signer.signingKey,
      publicKeys: signer.publicKeys,
    });
    try {
      const next: CallHandler = { handle: () => defer(() => of(callerContextFromCls(cls))) };
      const caller = await lastValueFrom(
        interceptor.intercept(kafkaContext(envelope({ tenantId, actorId: userId })), next),
      );
      expect(caller).toMatchObject({ userId, tenantId });
      expect(caller).not.toHaveProperty('principalAssertion');
    } finally {
      configurePrincipalAssertions(undefined);
    }
  });
});
