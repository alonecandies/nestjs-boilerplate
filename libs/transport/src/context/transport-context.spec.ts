import { AsyncLocalStorage } from 'node:async_hooks';
import { Metadata } from '@grpc/grpc-js';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { KafkaContext } from '@nestjs/microservices';
import { type Span, trace } from '@opentelemetry/api';
import { CLS_PRINCIPAL, createPrincipal, generateId } from '@platform/common';
import { KAFKA_HEADERS } from '@platform/contracts';
import { CLS_CORRELATION_ID, CLS_USER_ID, RequestContextService } from '@platform/observability';
import { CLS_ID, CLS_REQ, ClsService, ClsServiceManager } from 'nestjs-cls';
import { defer, lastValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { callerContextFromCls } from '../grpc/grpc-caller-context.js';
import { GrpcContextInterceptor } from '../grpc/grpc-context.interceptor.js';
import { createOutgoingMetadata } from '../grpc/grpc-metadata.js';
import { KafkaContextInterceptor } from '../kafka/kafka-context.interceptor.js';
import { correlationIdFromCls, RPC_CLS_KEYS, requestIdFromCls } from './transport-context.js';

const newCls = (): ClsService => new ClsService(new AsyncLocalStorage());

function rpcContext(rpcCtx: unknown, data: unknown = {}, type = 'rpc'): ExecutionContext {
  return {
    getType: () => type,
    switchToRpc: () => ({ getContext: () => rpcCtx, getData: () => data }),
  } as unknown as ExecutionContext;
}

/** Runs the interceptor and captures what the handler sees in nestjs-cls. */
async function seenBy(
  interceptor: GrpcContextInterceptor | KafkaContextInterceptor,
  cls: ClsService,
  context: ExecutionContext,
): Promise<{
  active: boolean;
  id?: unknown;
  correlationId?: unknown;
  userId?: unknown;
  caller?: unknown;
}> {
  const next: CallHandler = {
    handle: () =>
      defer(() =>
        of(
          cls.isActive()
            ? {
                active: true,
                id: cls.getId(),
                correlationId: cls.get<unknown>(RPC_CLS_KEYS.CORRELATION_ID),
                userId: cls.get<unknown>(RPC_CLS_KEYS.USER_ID),
                caller: cls.get<unknown>(RPC_CLS_KEYS.CALLER),
              }
            : { active: false },
        ),
      ),
  };
  return lastValueFrom(interceptor.intercept(context, next)) as Promise<{ active: boolean }>;
}

/** A running tracer's active span (the gRPC / kafkajs instrumentation span), as a spy. */
function activeSpanSpy(): { setAttribute: ReturnType<typeof vi.fn> } {
  const span = { setAttribute: vi.fn() };
  vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span as unknown as Span);
  return span;
}

describe('GrpcContextInterceptor', () => {
  it('adopts request id, correlation id and caller from metadata', async () => {
    const cls = newCls();
    const requestId = generateId();
    const userId = generateId();
    const metadata = createOutgoingMetadata({
      requestId,
      correlationId: 'corr-9',
      userId,
      roles: ['member'],
    });
    await expect(
      seenBy(new GrpcContextInterceptor(cls), cls, rpcContext(metadata)),
    ).resolves.toEqual({
      active: true,
      id: requestId,
      correlationId: 'corr-9',
      // RPC_CLS_KEYS.USER_ID is no longer written: the caller travels as CLS_PRINCIPAL (B2-23).
      userId: undefined,
      caller: { requestId, correlationId: 'corr-9', userId, roles: ['member'], staff: false },
    });
  });

  it('RequestContextService reads the caller from the principal', async () => {
    // getPrincipal() reads ClsServiceManager's store, so build everything on that one.
    const cls = ClsServiceManager.getClsService();
    const context = new RequestContextService(cls);
    const userId = generateId();
    const metadata = createOutgoingMetadata({
      correlationId: 'corr-7',
      userId,
      tenantId: generateId(),
    });
    const next: CallHandler = {
      handle: () =>
        defer(() => of({ userId: context.userId, correlationId: context.correlationId })),
    };
    await expect(
      lastValueFrom(new GrpcContextInterceptor(cls).intercept(rpcContext(metadata), next)),
    ).resolves.toEqual({ userId, correlationId: 'corr-7' });
    expect(RPC_CLS_KEYS.USER_ID).toBe(CLS_USER_ID);
    expect(RPC_CLS_KEYS.CORRELATION_ID).toBe(CLS_CORRELATION_ID);
  });

  it('tags the active span with the request and correlation ids (logs ↔ traces)', async () => {
    const span = activeSpanSpy();
    const cls = newCls();
    const requestId = generateId();
    const metadata = createOutgoingMetadata({ requestId, correlationId: 'corr-5' });
    await seenBy(new GrpcContextInterceptor(cls), cls, rpcContext(metadata));
    expect(span.setAttribute).toHaveBeenCalledWith('app.request_id', requestId);
    expect(span.setAttribute).toHaveBeenCalledWith('app.correlation_id', 'corr-5');
  });

  it('generates a request id and uses it as correlation id when the caller sent none', async () => {
    const cls = newCls();
    const seen = await seenBy(new GrpcContextInterceptor(cls), cls, rpcContext(new Metadata()));
    expect(seen.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen.correlationId).toBe(seen.id);
  });

  it('passes through non-gRPC contexts and apps without ClsModule', async () => {
    const cls = newCls();
    const interceptor = new GrpcContextInterceptor(cls);
    await expect(seenBy(interceptor, cls, rpcContext(new Metadata(), {}, 'http'))).resolves.toEqual(
      {
        active: false,
      },
    );
    await expect(seenBy(interceptor, cls, rpcContext({ not: 'metadata' }))).resolves.toEqual({
      active: false,
    });
    await expect(
      seenBy(new GrpcContextInterceptor(undefined), cls, rpcContext(new Metadata())),
    ).resolves.toEqual({ active: false });
  });
});

describe('KafkaContextInterceptor', () => {
  const kafka = (headers: Record<string, unknown>): KafkaContext =>
    new KafkaContext([
      { headers, offset: '1' } as never,
      0,
      'fixture.user-registered.v1',
      {} as never,
      () => Promise.resolve(),
      {} as never,
    ]);

  it('uses the envelope id as request id and the header as correlation id', async () => {
    const cls = newCls();
    const eventId = generateId();
    const seen = await seenBy(
      new KafkaContextInterceptor(cls),
      cls,
      rpcContext(kafka({ [KAFKA_HEADERS.CORRELATION_ID]: 'corr-h' }), {
        id: eventId,
        correlationId: 'corr-e',
      }),
    );
    expect(seen).toMatchObject({ active: true, id: eventId, correlationId: 'corr-h' });
  });

  it('tags the consumer span with the envelope id and the correlation id', async () => {
    const span = activeSpanSpy();
    const cls = newCls();
    const eventId = generateId();
    await seenBy(
      new KafkaContextInterceptor(cls),
      cls,
      rpcContext(kafka({ [KAFKA_HEADERS.CORRELATION_ID]: 'corr-k' }), { id: eventId }),
    );
    expect(span.setAttribute).toHaveBeenCalledWith('app.request_id', eventId);
    expect(span.setAttribute).toHaveBeenCalledWith('app.correlation_id', 'corr-k');
  });

  it('falls back to the envelope correlation id, then to the request id', async () => {
    const cls = newCls();
    const interceptor = new KafkaContextInterceptor(cls);
    const fromEnvelope = await seenBy(
      interceptor,
      cls,
      rpcContext(kafka({}), { id: generateId(), correlationId: 'corr-e' }),
    );
    expect(fromEnvelope.correlationId).toBe('corr-e');

    const unsafe = await seenBy(interceptor, cls, rpcContext(kafka({}), { id: 'bad id\n' }));
    expect(unsafe.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(unsafe.correlationId).toBe(unsafe.id);
  });

  it('ignores gRPC contexts', async () => {
    const cls = newCls();
    await expect(
      seenBy(new KafkaContextInterceptor(cls), cls, rpcContext(new Metadata())),
    ).resolves.toEqual({ active: false });
  });
});

describe('correlationIdFromCls / requestIdFromCls / callerContextFromCls', () => {
  it('return nothing outside a CLS context', () => {
    const cls = newCls();
    expect(correlationIdFromCls(cls)).toBeUndefined();
    expect(correlationIdFromCls(undefined)).toBeUndefined();
    expect(requestIdFromCls(cls)).toBeUndefined();
    expect(callerContextFromCls(cls)).toEqual({});
    // No principal vouches for an override's user outside a context: the call is anonymous.
    expect(callerContextFromCls(undefined, { userId: 'u1' })).toEqual({});
  });

  it('prefers the adopted correlation id, then the HTTP header, then the request id', () => {
    const cls = newCls();
    cls.run(() => {
      cls.set(CLS_ID, 'req-1');
      expect(correlationIdFromCls(cls)).toBe('req-1');
      cls.set(CLS_REQ, { headers: { 'x-correlation-id': 'corr-http' } });
      expect(correlationIdFromCls(cls)).toBe('corr-http');
      cls.set(RPC_CLS_KEYS.CORRELATION_ID, 'corr-rpc');
      expect(correlationIdFromCls(cls)).toBe('corr-rpc');
    });
  });

  it('builds the outgoing caller from the incoming gRPC caller; an override never changes its roles', () => {
    const cls = newCls();
    const userId = generateId();
    const tenantId = generateId();
    cls.run(() => {
      cls.set(CLS_ID, 'req-2');
      cls.set(RPC_CLS_KEYS.CALLER, { userId, tenantId, roles: ['admin'], staff: false });
      cls.set(CLS_PRINCIPAL, createPrincipal({ userId, tenantId, roles: ['admin'] }));
      expect(callerContextFromCls(cls)).toEqual({
        requestId: 'req-2',
        correlationId: 'req-2',
        userId,
        tenantId,
        roles: ['admin'],
      });
      expect(callerContextFromCls(cls, { userId, roles: ['member'] })).toMatchObject({
        userId,
        tenantId,
        roles: ['admin'],
      });
    });
  });
});
