import { AsyncLocalStorage } from 'node:async_hooks';
import type { Metadata } from '@grpc/grpc-js';
import { Logger } from '@nestjs/common';
import {
  CLS_PRINCIPAL,
  createPrincipal,
  generateId,
  markTokenVerified,
  type Principal,
  runWithPrincipal,
} from '@platform/common';
import { CLS_ID, ClsService, ClsServiceManager } from 'nestjs-cls';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { RPC_CLS_KEYS } from '../context/transport-context.js';
import { createTestPrincipalSigner } from '../testing/test-principal-signer.js';
import { GRPC_METADATA_KEYS } from './grpc.constants.js';
import { callerContextFromCls } from './grpc-caller-context.js';
import {
  createOutgoingMetadata,
  type RpcCallerContext,
  readIncomingMetadata,
} from './grpc-metadata.js';
import {
  checkPrincipalAssertion,
  configurePrincipalAssertions,
} from './grpc-principal-assertion.js';

const userId = generateId();
const tenantId = generateId();
const signer = createTestPrincipalSigner('edge-cc');
const CALLER_KEYS = [
  GRPC_METADATA_KEYS.USER_ID,
  GRPC_METADATA_KEYS.TENANT_ID,
  GRPC_METADATA_KEYS.USER_ROLES,
  GRPC_METADATA_KEYS.STAFF,
  GRPC_METADATA_KEYS.PRINCIPAL_ASSERTION,
] as const;

/** What a call carries for each caller key (empty arrays for an anonymous call). */
const callerKeysOf = (metadata: Metadata): Record<string, unknown[]> =>
  Object.fromEntries(CALLER_KEYS.map((key) => [key, metadata.get(key)]));
const anonymous = Object.fromEntries(CALLER_KEYS.map((key) => [key, []]));

/** Each test starts an hour after the last one, so no warning window carries over. */
let clock = Date.UTC(2100, 0, 1);

describe('callerContextFromCls: a caller leaves only for a principal the process can vouch for', () => {
  const cls = new ClsService(new AsyncLocalStorage());
  const marked = (): Principal =>
    markTokenVerified(createPrincipal({ userId, tenantId, roles: ['admin'] }));
  const sent = (overrides?: RpcCallerContext): Metadata =>
    createOutgoingMetadata(callerContextFromCls(cls, overrides));
  let warn: MockInstance<Logger['warn']>;

  beforeEach(() => {
    clock += 3_600_000;
    vi.useFakeTimers({ toFake: ['Date'], now: clock });
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    configurePrincipalAssertions(undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('an unmarked principal outside a gRPC call sends no caller, and one warning says so', () => {
    configurePrincipalAssertions({
      mode: 'off',
      signingKey: signer.signingKey,
      publicKeys: signer.publicKeys,
    });
    cls.run(() => {
      cls.set(CLS_ID, 'req-1');
      // An event's actor (KafkaContextInterceptor) or a principal set with runWithPrincipal.
      cls.set(CLS_PRINCIPAL, createPrincipal({ userId, tenantId, roles: ['admin'] }));
      const metadata = sent();
      expect(callerKeysOf(metadata)).toEqual(anonymous);
      expect(metadata.get(GRPC_METADATA_KEYS.REQUEST_ID)).toEqual(['req-1']);
      sent();
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(userId);
  });

  it('a lost mark under an override for the same user warns once, about the principal', () => {
    cls.run(() => {
      // The inbox owner's own id as the override, on an edge principal that lost its mark.
      cls.set(CLS_PRINCIPAL, createPrincipal({ userId, tenantId }));
      expect(callerKeysOf(sent({ userId }))).toEqual(anonymous);
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/CLS principal/);
  });

  it('the warning is throttled to one line a minute and counts the calls it held back', () => {
    cls.run(() => {
      cls.set(CLS_PRINCIPAL, createPrincipal({ userId, tenantId }));
      sent();
      sent();
      sent();
      vi.setSystemTime(clock + 61_000);
      sent();
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]?.[0])).toMatch(/2 more/);
  });

  it('an anonymous call or a vouched principal warns about nothing', () => {
    configurePrincipalAssertions({
      mode: 'off',
      signingKey: signer.signingKey,
      publicKeys: signer.publicKeys,
    });
    cls.run(() => {
      expect(callerKeysOf(sent())).toEqual(anonymous);
      expect(callerKeysOf(sent({}))).toEqual(anonymous);
      cls.set(CLS_PRINCIPAL, marked());
      expect(sent().get(GRPC_METADATA_KEYS.USER_ID)).toEqual([userId]);
      expect(sent({ userId }).get(GRPC_METADATA_KEYS.USER_ID)).toEqual([userId]);
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['tenant', { tenantId: generateId() }],
    ['roles', { roles: ['owner'] }],
    ['staff flag', { staff: true }],
    ['assertion', { principalAssertion: 'a.b.c' }],
  ])('an override of the %s changes nothing that is sent', (_label, widened) => {
    configurePrincipalAssertions({
      mode: 'off',
      signingKey: signer.signingKey,
      publicKeys: signer.publicKeys,
    });
    cls.run(() => {
      cls.set(CLS_PRINCIPAL, marked());
      const plain = callerKeysOf(sent());
      const metadata = sent({ userId, ...widened });
      const { [GRPC_METADATA_KEYS.PRINCIPAL_ASSERTION]: assertion, ...headers } =
        callerKeysOf(metadata);
      const { [GRPC_METADATA_KEYS.PRINCIPAL_ASSERTION]: _plainAssertion, ...plainHeaders } = plain;
      expect(headers).toEqual(plainHeaders);
      expect(headers[GRPC_METADATA_KEYS.USER_ID]).toEqual([userId]);
      expect(headers[GRPC_METADATA_KEYS.TENANT_ID]).toEqual([tenantId]);
      expect(headers[GRPC_METADATA_KEYS.USER_ROLES]).toEqual(['admin']);
      expect(assertion).toHaveLength(1);
      expect(checkPrincipalAssertion(readIncomingMetadata(metadata), signer.publicKeys)).toBe(
        'valid',
      );
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('an override naming another user makes the call anonymous', () => {
    configurePrincipalAssertions({
      mode: 'off',
      signingKey: signer.signingKey,
      publicKeys: signer.publicKeys,
    });
    cls.run(() => {
      cls.set(CLS_PRINCIPAL, marked());
      expect(callerKeysOf(sent({ userId: generateId() }))).toEqual(anonymous);
    });
    // Nothing vouches for an override outside a CLS context either.
    expect(
      callerKeysOf(createOutgoingMetadata(callerContextFromCls(undefined, { userId }))),
    ).toEqual(anonymous);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('request and correlation id overrides still apply', () => {
    cls.run(() => {
      cls.set(CLS_ID, 'req-2');
      expect(callerContextFromCls(cls, { requestId: 'req-3', correlationId: 'corr-3' })).toEqual({
        requestId: 'req-3',
        correlationId: 'corr-3',
      });
    });
  });

  it("inside a gRPC call it forwards the call's own principal, and no other", () => {
    configurePrincipalAssertions({
      mode: 'off',
      signingKey: signer.signingKey,
      publicKeys: signer.publicKeys,
    });
    const caller = { userId, tenantId, roles: ['admin'], staff: false };
    const received = signer.metadata(caller);
    const [assertion] = received.get(GRPC_METADATA_KEYS.PRINCIPAL_ASSERTION);
    const store = ClsServiceManager.getClsService(); // the store runWithPrincipal uses
    store.run(() => {
      // What GrpcContextInterceptor writes: an unmarked principal adopted from the metadata.
      store.set(RPC_CLS_KEYS.CALLER, readIncomingMetadata(received));
      store.set(CLS_PRINCIPAL, createPrincipal(caller));
      expect(callerKeysOf(createOutgoingMetadata(callerContextFromCls(store)))).toEqual({
        ...anonymous,
        [GRPC_METADATA_KEYS.USER_ID]: [userId],
        [GRPC_METADATA_KEYS.TENANT_ID]: [tenantId],
        [GRPC_METADATA_KEYS.USER_ROLES]: ['admin'],
        [GRPC_METADATA_KEYS.PRINCIPAL_ASSERTION]: [assertion],
      });
      const other = runWithPrincipal(createPrincipal({ userId: generateId(), tenantId }), () =>
        callerKeysOf(createOutgoingMetadata(callerContextFromCls(store))),
      );
      expect(other).toEqual(anonymous);
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
