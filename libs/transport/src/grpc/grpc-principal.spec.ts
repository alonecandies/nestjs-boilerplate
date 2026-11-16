import { AsyncLocalStorage } from 'node:async_hooks';
import { Metadata } from '@grpc/grpc-js';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { CLS_PRINCIPAL, createPrincipal, generateId, PLATFORM_TENANT_ID } from '@platform/common';
import { CLS_REQ, ClsService } from 'nestjs-cls';
import { defer, lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { callerContextFromCls } from './grpc-caller-context.js';
import { GrpcContextInterceptor } from './grpc-context.interceptor.js';
import { createOutgoingMetadata, readIncomingMetadata } from './grpc-metadata.js';
import { principalFromRpcCaller, rpcCallerOf } from './grpc-principal.js';

const userId = generateId();
const tenantId = generateId();

function rpcContext(metadata: unknown): ExecutionContext {
  return {
    getType: () => 'rpc',
    switchToRpc: () => ({ getContext: () => metadata, getData: () => ({}) }),
  } as unknown as ExecutionContext;
}

const metadataOf = (entries: Record<string, string>): Metadata => {
  const metadata = new Metadata();
  for (const [key, value] of Object.entries(entries)) metadata.set(key, value);
  return metadata;
};

describe('gRPC principal metadata', () => {
  it('round-trips user, tenant, roles and staff', () => {
    const outgoing = createOutgoingMetadata({ userId, tenantId, roles: ['admin'], staff: true });
    expect(outgoing.get('x-tenant-id')).toEqual([tenantId]);
    expect(outgoing.get('x-staff')).toEqual(['true']);
    expect(readIncomingMetadata(outgoing)).toMatchObject({
      userId,
      tenantId,
      roles: ['admin'],
      staff: true,
    });
  });

  it('omits x-staff unless staff is true', () => {
    expect(createOutgoingMetadata({ userId, tenantId, staff: false }).get('x-staff')).toEqual([]);
  });

  it.each(['TRUE', '1', 'yes', ' true'])(
    'reads x-staff %j as false (only the exact string "true")',
    (value) => {
      expect(
        readIncomingMetadata(metadataOf({ 'x-user-id': userId, 'x-staff': value })).staff,
      ).toBe(false);
    },
  );
});

describe('principalFromRpcCaller', () => {
  it('builds the principal and drops unknown roles', () => {
    const caller = readIncomingMetadata(
      metadataOf({
        'x-user-id': userId,
        'x-tenant-id': tenantId,
        'x-user-roles': 'owner,root,owner',
      }),
    );
    expect(principalFromRpcCaller(caller)).toEqual({
      userId,
      tenantId,
      roles: ['owner'],
      staff: false,
    });
  });

  it('is undefined without a user (the tenant alone means nothing)', () => {
    expect(
      principalFromRpcCaller(readIncomingMetadata(metadataOf({ 'x-tenant-id': tenantId }))),
    ).toBeUndefined();
    expect(principalFromRpcCaller(readIncomingMetadata(undefined))).toBeUndefined();
  });

  it('a user without a tenant is user-scoped: roles and staff are dropped', () => {
    const caller = readIncomingMetadata(
      metadataOf({ 'x-user-id': userId, 'x-user-roles': 'admin', 'x-staff': 'true' }),
    );
    expect(principalFromRpcCaller(caller)).toEqual({
      userId,
      tenantId: null,
      roles: [],
      staff: false,
    });
  });

  it.each([
    ['a user id that is not a UUID', { 'x-user-id': 'u-1', 'x-tenant-id': tenantId }],
    ['a malformed tenant', { 'x-user-id': userId, 'x-tenant-id': 'acme' }],
    ['the nil (platform) tenant', { 'x-user-id': userId, 'x-tenant-id': PLATFORM_TENANT_ID }],
  ])('rejects %s with INVALID_PRINCIPAL', (_label, entries) => {
    expect(() => principalFromRpcCaller(readIncomingMetadata(metadataOf(entries)))).toThrow(
      expect.objectContaining({ code: 'INVALID_PRINCIPAL' }),
    );
  });

  it('rpcCallerOf is the inverse for a tenant principal', () => {
    const principal = createPrincipal({ userId, tenantId, roles: ['member'], staff: false });
    expect(rpcCallerOf(principal)).toEqual({ userId, tenantId, roles: ['member'] });
  });
});

describe('GrpcContextInterceptor and callerContextFromCls', () => {
  const cls = new ClsService(new AsyncLocalStorage());
  const interceptor = new GrpcContextInterceptor(cls);
  const seen = (metadata: unknown) => {
    const next: CallHandler = { handle: () => defer(() => of(cls.get<unknown>(CLS_PRINCIPAL))) };
    return lastValueFrom(interceptor.intercept(rpcContext(metadata), next));
  };

  it('puts the caller principal into CLS for the handler', async () => {
    await expect(
      seen(createOutgoingMetadata({ userId, tenantId, roles: ['admin'], staff: true })),
    ).resolves.toEqual({ userId, tenantId, roles: ['admin'], staff: true });
  });

  it('sets no principal for an anonymous call', async () => {
    await expect(seen(createOutgoingMetadata({}))).resolves.toBeUndefined();
  });

  it('fails the call with UNAUTHENTICATED INVALID_PRINCIPAL for a hostile tenant', async () => {
    await expect(
      seen(metadataOf({ 'x-user-id': userId, 'x-tenant-id': PLATFORM_TENANT_ID })),
    ).rejects.toMatchObject({
      code: 'INVALID_PRINCIPAL',
    });
  });

  it('forwards the CLS principal on outgoing calls; an override for the same user keeps it', () => {
    cls.run(() => {
      cls.set(CLS_PRINCIPAL, createPrincipal({ userId, tenantId, roles: ['owner'], staff: false }));
      expect(callerContextFromCls(cls)).toMatchObject({ userId, tenantId, roles: ['owner'] });
      expect(callerContextFromCls(cls)).not.toHaveProperty('staff');
      expect(callerContextFromCls(cls, { userId })).toMatchObject({ userId, tenantId });
    });
  });

  it("never pairs another user's id with the principal's tenant, roles or staff flag", () => {
    cls.run(() => {
      cls.set(CLS_PRINCIPAL, createPrincipal({ userId, tenantId, roles: ['owner'], staff: true }));
      const other = generateId();
      const caller = callerContextFromCls(cls, { userId: other });
      expect(caller).toMatchObject({ userId: other });
      expect(caller).not.toHaveProperty('tenantId');
      expect(caller).not.toHaveProperty('roles');
      expect(caller).not.toHaveProperty('staff');
    });
  });

  it('never forwards client request headers: only the CLS principal travels', () => {
    cls.run(() => {
      // A hostile HTTP client sends the internal metadata names as headers.
      cls.set(CLS_REQ, {
        headers: { 'x-user-id': generateId(), 'x-tenant-id': generateId(), 'x-staff': 'true' },
      });
      cls.set(CLS_PRINCIPAL, createPrincipal({ userId, tenantId, roles: ['member'] }));
      const metadata = createOutgoingMetadata(callerContextFromCls(cls));
      expect(metadata.get('x-user-id')).toEqual([userId]);
      expect(metadata.get('x-tenant-id')).toEqual([tenantId]);
      expect(metadata.get('x-staff')).toEqual([]);
    });
  });
});
