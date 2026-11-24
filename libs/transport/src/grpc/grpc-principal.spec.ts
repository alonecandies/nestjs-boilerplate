import { AsyncLocalStorage } from 'node:async_hooks';
import { Metadata } from '@grpc/grpc-js';
import { type CallHandler, type ExecutionContext, Logger } from '@nestjs/common';
import {
  CLS_PRINCIPAL,
  createPrincipal,
  generateId,
  markTokenVerified,
  PLATFORM_TENANT_ID,
} from '@platform/common';
import { CLS_REQ, ClsService } from 'nestjs-cls';
import { defer, lastValueFrom, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { createTestPrincipalSigner } from '../testing/test-principal-signer.js';
import { callerContextFromCls } from './grpc-caller-context.js';
import { GrpcContextInterceptor } from './grpc-context.interceptor.js';
import { createOutgoingMetadata, readIncomingMetadata } from './grpc-metadata.js';
import { principalFromRpcCaller, rpcCallerOf } from './grpc-principal.js';
import { configurePrincipalAssertions } from './grpc-principal-assertion.js';

const userId = generateId();
const tenantId = generateId();

function rpcContext(metadata: unknown): ExecutionContext {
  return {
    getType: () => 'rpc',
    switchToRpc: () => ({ getContext: () => metadata, getData: () => ({}) }),
    getClass: () => class UsersRpc {},
    getHandler: () =>
      function getUser() {
        return undefined;
      },
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
      // What the edge's own token verification writes (`writePrincipal` in @platform/auth).
      cls.set(
        CLS_PRINCIPAL,
        markTokenVerified(createPrincipal({ userId, tenantId, roles: ['owner'], staff: false })),
      );
      expect(callerContextFromCls(cls)).toMatchObject({ userId, tenantId, roles: ['owner'] });
      expect(callerContextFromCls(cls)).not.toHaveProperty('staff');
      expect(callerContextFromCls(cls, { userId })).toMatchObject({ userId, tenantId });
    });
  });

  it("never pairs another user's id with the principal's tenant, roles or staff flag", () => {
    cls.run(() => {
      cls.set(
        CLS_PRINCIPAL,
        markTokenVerified(createPrincipal({ userId, tenantId, roles: ['owner'], staff: true })),
      );
      const other = generateId();
      const caller = callerContextFromCls(cls, { userId: other });
      // An override naming another user is vouched for by nobody: the call is anonymous.
      expect(caller).not.toHaveProperty('userId');
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
      cls.set(
        CLS_PRINCIPAL,
        markTokenVerified(createPrincipal({ userId, tenantId, roles: ['member'] })),
      );
      const metadata = createOutgoingMetadata(callerContextFromCls(cls));
      expect(metadata.get('x-user-id')).toEqual([userId]);
      expect(metadata.get('x-tenant-id')).toEqual([tenantId]);
      expect(metadata.get('x-staff')).toEqual([]);
    });
  });
});

describe('GrpcContextInterceptor with GRPC_PRINCIPAL_ASSERTION=enforce', () => {
  const cls = new ClsService(new AsyncLocalStorage());
  const interceptor = new GrpcContextInterceptor(cls);
  const signer = createTestPrincipalSigner('edge-1');
  const caller = { userId, tenantId, roles: ['owner'], staff: true };
  const seen = (metadata: unknown) => {
    const next: CallHandler = {
      handle: () =>
        defer(() =>
          of({
            principal: cls.get<unknown>(CLS_PRINCIPAL),
            forwarded: callerContextFromCls(cls).principalAssertion,
          }),
        ),
    };
    return lastValueFrom(interceptor.intercept(rpcContext(metadata), next));
  };
  const refused = { code: 'INVALID_PRINCIPAL', httpStatus: 401 };

  afterEach(() => {
    configurePrincipalAssertions(undefined);
    vi.useRealTimers();
  });
  const enforce = (publicKeys = signer.publicKeys): void =>
    configurePrincipalAssertions({ mode: 'enforce', publicKeys });

  it('builds the principal from a valid assertion and forwards its bytes', async () => {
    enforce();
    const metadata = signer.metadata(caller);
    const [assertion] = metadata.get('x-principal-assertion');
    await expect(seen(metadata)).resolves.toEqual({
      principal: { userId, tenantId, roles: ['owner'], staff: true },
      forwarded: assertion,
    });
  });

  it('refuses plain headers without an assertion (UNAUTHENTICATED INVALID_PRINCIPAL)', async () => {
    enforce();
    await expect(seen(createOutgoingMetadata(caller))).rejects.toMatchObject(refused);
  });

  it('tells a refused caller nothing about why: the refusal carries no details', async () => {
    enforce();
    const expired = signer.metadata(caller, { nowMs: Date.now() - 600_000 });
    for (const metadata of [createOutgoingMetadata(caller), expired]) {
      const error: unknown = await seen(metadata).catch((thrown: unknown) => thrown);
      expect(error).toMatchObject(refused);
      expect(error).not.toHaveProperty('details');
    }
  });

  it('lets an anonymous call through with no principal (register, login, a webhook)', async () => {
    enforce();
    await expect(seen(createOutgoingMetadata({ requestId: generateId() }))).resolves.toEqual({
      principal: undefined,
      forwarded: undefined,
    });
  });

  it('refuses an assertion signed by another key', async () => {
    enforce();
    const other = createTestPrincipalSigner('edge-1');
    await expect(seen(other.metadata(caller))).rejects.toMatchObject(refused);
  });

  it('refuses an expired assertion, and one replayed after its expiry', async () => {
    enforce();
    const ttlMs = signer.signingKey.ttlSec * 1000;
    await expect(
      seen(signer.metadata(caller, { nowMs: Date.now() - ttlMs - 60_000 })),
    ).rejects.toMatchObject(refused);

    const captured = signer.metadata(caller);
    await expect(seen(captured)).resolves.toMatchObject({ principal: { userId } });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + ttlMs + 60_000);
    await expect(seen(captured)).rejects.toMatchObject(refused);
  });

  it('refuses a tampered claim (another role and the staff flag on a member assertion)', async () => {
    enforce();
    const member = { userId, tenantId, roles: ['member'] };
    const [header = '', , signature = ''] = signer.sign(member).split('.');
    const now = Math.floor(Date.now() / 1000);
    const claims = Buffer.from(
      JSON.stringify({
        iss: 'edge',
        sub: userId,
        tid: tenantId,
        roles: ['owner'],
        staff: true,
        iat: now,
        exp: now + 120,
      }),
    ).toString('base64url');
    const metadata = createOutgoingMetadata({
      ...caller,
      principalAssertion: `${header}.${claims}.${signature}`,
    });
    await expect(seen(metadata)).rejects.toMatchObject(refused);
  });

  it('refuses plain headers that differ from a valid assertion: the signed claims decide', async () => {
    enforce();
    const member = { userId, tenantId, roles: ['member'] };
    const metadata = createOutgoingMetadata({
      ...caller,
      principalAssertion: signer.sign(member),
    });
    await expect(seen(metadata)).rejects.toMatchObject(refused);
  });

  it('refuses an assertion without x-user-id, and one whose claims are not a valid principal', async () => {
    enforce();
    const metadata = createOutgoingMetadata({ principalAssertion: signer.sign(caller) });
    await expect(seen(metadata)).rejects.toMatchObject(refused);
    const platform = { userId, tenantId: PLATFORM_TENANT_ID };
    await expect(seen(signer.metadata(platform))).rejects.toMatchObject(refused);
  });

  it('keeps the plain-header principal in warn (nothing refused)', async () => {
    configurePrincipalAssertions({ mode: 'warn', publicKeys: signer.publicKeys });
    await expect(seen(createOutgoingMetadata(caller))).resolves.toMatchObject({
      principal: { userId, tenantId, roles: ['owner'], staff: true },
    });
  });

  describe('a principal createPrincipal rejects (the reason stays in the log)', () => {
    let warn: MockInstance<Logger['warn']>;
    beforeEach(() => {
      warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => vi.restoreAllMocks());

    const refusal = async (metadata: Metadata): Promise<unknown> => {
      // A fresh interceptor: no warning window carries over from another case.
      const fresh = new GrpcContextInterceptor(cls);
      const next: CallHandler = { handle: () => of(undefined) };
      return lastValueFrom(fresh.intercept(rpcContext(metadata), next)).then(
        () => {
          throw new Error('expected the call to be refused');
        },
        (thrown: unknown) => thrown,
      );
    };
    const platform = { userId, tenantId: PLATFORM_TENANT_ID };

    it('enforce: a validly signed assertion whose claims are not a principal has no details', async () => {
      enforce();
      for (const claims of [platform, { userId: 'not-a-uuid', tenantId }]) {
        const error = await refusal(signer.metadata(claims));
        expect(error).toMatchObject(refused);
        expect(error).not.toHaveProperty('details');
      }
    });

    it.each(['off', 'warn'] as const)(
      '%s: malformed plain headers are refused with no details',
      async (mode) => {
        configurePrincipalAssertions({ mode, publicKeys: signer.publicKeys });
        for (const entries of [
          { 'x-user-id': 'u-1', 'x-tenant-id': tenantId },
          { 'x-user-id': userId, 'x-tenant-id': 'acme' },
          { 'x-user-id': userId, 'x-tenant-id': PLATFORM_TENANT_ID },
        ]) {
          const error = await refusal(metadataOf(entries));
          expect(error).toMatchObject(refused);
          expect(error).not.toHaveProperty('details');
        }
      },
    );

    it('logs the reason once a minute per handler, without the caller ids', async () => {
      configurePrincipalAssertions({ mode: 'off', publicKeys: signer.publicKeys });
      const fresh = new GrpcContextInterceptor(cls);
      const next: CallHandler = { handle: () => of(undefined) };
      const metadata = metadataOf({ 'x-user-id': userId, 'x-tenant-id': PLATFORM_TENANT_ID });
      for (let i = 0; i < 3; i += 1) {
        await expect(
          lastValueFrom(fresh.intercept(rpcContext(metadata), next)),
        ).rejects.toMatchObject(refused);
      }
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toMatch(/tenantId is the platform tenant/);
      expect(line).toMatch(/UsersRpc\.getUser/);
      expect(line).not.toContain(userId);
      expect(line).not.toContain(PLATFORM_TENANT_ID);
    });
  });
});
