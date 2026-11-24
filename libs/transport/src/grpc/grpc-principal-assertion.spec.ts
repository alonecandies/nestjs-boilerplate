import { AsyncLocalStorage } from 'node:async_hooks';
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { Metadata } from '@grpc/grpc-js';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import {
  CLS_PRINCIPAL,
  createPrincipal,
  generateId,
  markTokenVerified,
  runWithPrincipal,
} from '@platform/common';
import { ClsService, ClsServiceManager } from 'nestjs-cls';
import { register } from 'prom-client';
import { defer, lastValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { RPC_CLS_KEYS } from '../context/transport-context.js';
import { GRPC_METADATA_KEYS } from './grpc.constants.js';
import { callerContextFromCls } from './grpc-caller-context.js';
import { GrpcContextInterceptor } from './grpc-context.interceptor.js';
import { createOutgoingMetadata, readIncomingMetadata } from './grpc-metadata.js';
import {
  checkPrincipalAssertion,
  configurePrincipalAssertions,
  GRPC_PRINCIPAL_ASSERTIONS_TOTAL,
  type PrincipalAssertionSettings,
  principalAssertionSettingsFrom,
  signPrincipalAssertion,
  verifyPrincipalAssertion,
} from './grpc-principal-assertion.js';

const userId = generateId();
const tenantId = generateId();
const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);

const pair = (): { privateKey: KeyObject; publicKey: KeyObject } =>
  generateKeyPairSync('ec', { namedCurve: 'P-256' });
const edge = pair();
const other = pair();
const signingKey = { keyId: 'k1', privateKey: edge.privateKey, ttlSec: 120 };
const publicKeys = new Map([['k1', edge.publicKey]]);
const caller = { userId, tenantId, roles: ['admin'], staff: false };

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A token with the given header and payload, signed by `key` (ES256, IEEE P1363). */
function forge(header: unknown, payload: unknown, key: KeyObject = edge.privateKey): string {
  const input = `${b64url(header)}.${b64url(payload)}`;
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}
const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: 'edge',
  sub: userId,
  tid: tenantId,
  roles: ['admin'],
  iat: NOW / 1000,
  exp: NOW / 1000 + 120,
  ...overrides,
});

describe('signPrincipalAssertion / verifyPrincipalAssertion (compact ES256 JWS)', () => {
  it('round-trips user, tenant, roles and staff, with kid, iss, iat and exp', () => {
    const token = signPrincipalAssertion({ ...caller, staff: true }, signingKey, NOW);
    const [header, payload] = token
      .split('.')
      .slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, 'base64url').toString()) as unknown);
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'k1' });
    expect(payload).toEqual({ ...claims(), staff: true });
    expect(verifyPrincipalAssertion(token, publicKeys, NOW + 60_000)).toEqual({
      outcome: 'valid',
      caller: { userId, tenantId, roles: ['admin'], staff: true },
    });
  });

  it('a user-scoped caller carries no tenant, roles or staff', () => {
    const token = signPrincipalAssertion({ userId, roles: [], staff: false }, signingKey, NOW);
    expect(verifyPrincipalAssertion(token, publicKeys, NOW)).toEqual({
      outcome: 'valid',
      caller: { userId, roles: [], staff: false },
    });
  });

  it('is expired after exp (replayed late) and invalid before iat', () => {
    const token = signPrincipalAssertion(caller, signingKey, NOW);
    expect(verifyPrincipalAssertion(token, publicKeys, NOW + 121_000 + 10_000).outcome).toBe(
      'expired',
    );
    expect(verifyPrincipalAssertion(token, publicKeys, NOW - 60_000).outcome).toBe('invalid');
  });

  it.each([
    ['an unknown key id', () => forge({ alg: 'ES256', kid: 'k9' }, claims())],
    [
      'another key under a known key id',
      () => forge({ alg: 'ES256', kid: 'k1' }, claims(), other.privateKey),
    ],
    ['alg none', () => `${b64url({ alg: 'none', kid: 'k1' })}.${b64url(claims())}.`],
    ['alg HS256', () => forge({ alg: 'HS256', kid: 'k1' }, claims())],
    ['another issuer', () => forge({ alg: 'ES256', kid: 'k1' }, claims({ iss: 'a-mesh-peer' }))],
    ['a missing subject', () => forge({ alg: 'ES256', kid: 'k1' }, claims({ sub: undefined }))],
    ['exp before iat', () => forge({ alg: 'ES256', kid: 'k1' }, claims({ exp: NOW / 1000 - 1 }))],
    ['garbage', () => 'not.a.jws'],
    ['two parts', () => 'abc.def'],
  ])('refuses %s as invalid', (_label, token) => {
    expect(verifyPrincipalAssertion(token(), publicKeys, NOW).outcome).toBe('invalid');
  });

  it('refuses a tampered claim (the signature covers header and payload)', () => {
    const [header = '', , signature = ''] = signPrincipalAssertion(caller, signingKey, NOW).split(
      '.',
    );
    const tampered = `${header}.${b64url(claims({ roles: ['owner'], staff: true }))}.${signature}`;
    expect(verifyPrincipalAssertion(tampered, publicKeys, NOW).outcome).toBe('invalid');
  });

  it('ignores claims it does not know (a newer edge may add some)', () => {
    const token = forge({ alg: 'ES256', kid: 'k1' }, claims({ jti: 'x', aud: 'svc' }));
    expect(verifyPrincipalAssertion(token, publicKeys, NOW).outcome).toBe('valid');
  });
});

describe('checkPrincipalAssertion (what a warn-mode server counts)', () => {
  const incoming = (entries: { assertion?: string } & Record<string, unknown> = {}) => {
    const { assertion, ...ctx } = entries;
    return readIncomingMetadata(
      createOutgoingMetadata({
        ...ctx,
        ...(assertion === undefined ? {} : { principalAssertion: assertion }),
      }),
    );
  };

  it('valid when the signed claims equal the plain headers', () => {
    const assertion = signPrincipalAssertion(caller, signingKey, NOW);
    expect(checkPrincipalAssertion(incoming({ ...caller, assertion }), publicKeys, NOW)).toBe(
      'valid',
    );
  });

  it('missing when a user is asserted in plain headers only (an old gateway)', () => {
    expect(checkPrincipalAssertion(incoming(caller), publicKeys, NOW)).toBe('missing');
  });

  it('nothing to count for an anonymous call (register, login, a webhook)', () => {
    expect(checkPrincipalAssertion(incoming({}), publicKeys, NOW)).toBeUndefined();
  });

  it('mismatch when the plain headers claim more than the assertion', () => {
    const assertion = signPrincipalAssertion(caller, signingKey, NOW);
    expect(
      checkPrincipalAssertion(incoming({ ...caller, staff: true, assertion }), publicKeys, NOW),
    ).toBe('mismatch');
    expect(
      checkPrincipalAssertion(
        incoming({ ...caller, userId: generateId(), assertion }),
        publicKeys,
        NOW,
      ),
    ).toBe('mismatch');
    expect(checkPrincipalAssertion(incoming({ assertion }), publicKeys, NOW)).toBe('mismatch');
  });

  it('expired and invalid pass through', () => {
    const assertion = signPrincipalAssertion(caller, signingKey, NOW);
    expect(
      checkPrincipalAssertion(incoming({ ...caller, assertion }), publicKeys, NOW + 600_000),
    ).toBe('expired');
    expect(
      checkPrincipalAssertion(incoming({ ...caller, assertion: 'x.y.z' }), publicKeys, NOW),
    ).toBe('invalid');
  });
});

describe('callerContextFromCls: the edge signs, a service forwards', () => {
  const cls = new ClsService(new AsyncLocalStorage());
  // What the edge's own token verification writes (`writePrincipal` in @platform/auth).
  const principal = markTokenVerified(createPrincipal({ userId, tenantId, roles: ['admin'] }));
  const signer: PrincipalAssertionSettings = {
    mode: 'off',
    signingKey,
    publicKeys,
  };
  afterEach(() => configurePrincipalAssertions(undefined));

  it('an edge with a signing key signs exactly the caller it sends in plain headers', () => {
    configurePrincipalAssertions(signer);
    cls.run(() => {
      cls.set(CLS_PRINCIPAL, principal);
      const metadata = createOutgoingMetadata(callerContextFromCls(cls));
      const [token] = metadata.get(GRPC_METADATA_KEYS.PRINCIPAL_ASSERTION);
      expect(typeof token).toBe('string');
      expect(checkPrincipalAssertion(readIncomingMetadata(metadata), publicKeys)).toBe('valid');
    });
  });

  it('an edge without a signing key (an old gateway) sends no assertion', () => {
    configurePrincipalAssertions({ mode: 'off', publicKeys });
    cls.run(() => {
      cls.set(CLS_PRINCIPAL, principal);
      expect(callerContextFromCls(cls)).not.toHaveProperty('principalAssertion');
    });
  });

  it('no assertion for an anonymous call or for an override naming another user', () => {
    configurePrincipalAssertions(signer);
    cls.run(() => {
      expect(callerContextFromCls(cls)).not.toHaveProperty('principalAssertion');
      cls.set(CLS_PRINCIPAL, principal);
      expect(callerContextFromCls(cls, { userId: generateId() })).not.toHaveProperty(
        'principalAssertion',
      );
      expect(callerContextFromCls(cls, { userId })).toHaveProperty('principalAssertion');
    });
  });

  it('never signs or names a principal its own token verification did not write, even with a key', () => {
    configurePrincipalAssertions(signer);
    cls.run(() => {
      // An event's actor (KafkaContextInterceptor) or a principal set by code: nothing vouches for
      // it, so the call is anonymous, plain headers included.
      cls.set(CLS_PRINCIPAL, createPrincipal({ userId, tenantId, roles: ['admin'] }));
      const unsigned = callerContextFromCls(cls);
      expect(unsigned).not.toHaveProperty('userId');
      expect(unsigned).not.toHaveProperty('tenantId');
      expect(unsigned).not.toHaveProperty('roles');
      expect(unsigned).not.toHaveProperty('principalAssertion');
    });
  });

  it('runWithPrincipal inside an edge request signs and names nothing for the principal it sets', () => {
    configurePrincipalAssertions(signer);
    const store = ClsServiceManager.getClsService(); // the store runWithPrincipal uses
    store.run(() => {
      store.set(CLS_PRINCIPAL, principal);
      expect(callerContextFromCls(store)).toHaveProperty('principalAssertion');
      const inner = runWithPrincipal(createPrincipal({ userId, tenantId, roles: ['owner'] }), () =>
        callerContextFromCls(store),
      );
      expect(inner).not.toHaveProperty('userId');
      expect(inner).not.toHaveProperty('roles');
      expect(inner).not.toHaveProperty('principalAssertion');
    });
  });

  it.each([
    ['tenant', { tenantId: generateId() }],
    ['roles', { roles: ['owner'] }],
    ['staff flag', { staff: true }],
  ])("signs the principal's own claims: an override of the %s is ignored", (_label, widened) => {
    configurePrincipalAssertions(signer);
    cls.run(() => {
      cls.set(CLS_PRINCIPAL, principal);
      const metadata = createOutgoingMetadata(callerContextFromCls(cls, { userId, ...widened }));
      expect(metadata.get(GRPC_METADATA_KEYS.PRINCIPAL_ASSERTION)).toHaveLength(1);
      expect(metadata.get(GRPC_METADATA_KEYS.TENANT_ID)).toEqual([tenantId]);
      expect(metadata.get(GRPC_METADATA_KEYS.USER_ROLES)).toEqual(['admin']);
      expect(metadata.get(GRPC_METADATA_KEYS.STAFF)).toEqual([]);
      expect(checkPrincipalAssertion(readIncomingMetadata(metadata), publicKeys)).toBe('valid');
    });
  });

  it('inside a gRPC call it forwards the received bytes and never signs, even with a key', () => {
    configurePrincipalAssertions(signer);
    const received = signPrincipalAssertion(caller, signingKey, NOW);
    cls.run(() => {
      cls.set(CLS_PRINCIPAL, principal);
      cls.set(
        RPC_CLS_KEYS.CALLER,
        readIncomingMetadata(createOutgoingMetadata({ ...caller, principalAssertion: received })),
      );
      expect(callerContextFromCls(cls).principalAssertion).toBe(received);
      expect(callerContextFromCls(cls, { userId: generateId() })).not.toHaveProperty(
        'principalAssertion',
      );
    });
    cls.run(() => {
      // Plain headers only (an old gateway): nothing to forward, and no signature is minted.
      cls.set(CLS_PRINCIPAL, principal);
      cls.set(RPC_CLS_KEYS.CALLER, readIncomingMetadata(createOutgoingMetadata(caller)));
      expect(callerContextFromCls(cls)).not.toHaveProperty('principalAssertion');
    });
  });
});

describe('GrpcContextInterceptor in warn mode', () => {
  const cls = new ClsService(new AsyncLocalStorage());
  const interceptor = new GrpcContextInterceptor(cls);
  afterEach(() => configurePrincipalAssertions(undefined));

  const rpcContext = (metadata: Metadata): ExecutionContext =>
    ({
      getType: () => 'rpc',
      getClass: () => ({ name: 'UsersController' }),
      getHandler: () => ({ name: 'getUser' }),
      switchToRpc: () => ({ getContext: () => metadata, getData: () => ({}) }),
    }) as unknown as ExecutionContext;
  const principalSeen = (metadata: Metadata) => {
    const next: CallHandler = { handle: () => defer(() => of(cls.get<unknown>(CLS_PRINCIPAL))) };
    return lastValueFrom(interceptor.intercept(rpcContext(metadata), next));
  };
  const count = async (outcome: string): Promise<number> => {
    const metric = register.getSingleMetric(GRPC_PRINCIPAL_ASSERTIONS_TOTAL);
    const values = metric === undefined ? [] : (await metric.get()).values;
    return values.find((sample) => sample.labels['outcome'] === outcome)?.value ?? 0;
  };

  it('counts each outcome and still builds the principal from the plain headers', async () => {
    configurePrincipalAssertions({ mode: 'warn', publicKeys });
    const before = { valid: await count('valid'), mismatch: await count('mismatch') };
    const assertion = signPrincipalAssertion(caller, signingKey);
    await expect(
      principalSeen(createOutgoingMetadata({ ...caller, principalAssertion: assertion })),
    ).resolves.toMatchObject({ userId, tenantId, roles: ['admin'] });
    await expect(
      principalSeen(
        createOutgoingMetadata({ ...caller, roles: ['owner'], principalAssertion: assertion }),
      ),
    ).resolves.toMatchObject({ roles: ['owner'] });
    expect(await count('valid')).toBe(before.valid + 1);
    expect(await count('mismatch')).toBe(before.mismatch + 1);
  });

  it('counts nothing in off mode', async () => {
    configurePrincipalAssertions({ mode: 'off', publicKeys });
    const before = await count('missing');
    await principalSeen(createOutgoingMetadata(caller));
    expect(await count('missing')).toBe(before);
  });
});

describe('principalAssertionSettingsFrom', () => {
  it('builds key objects from the grpc namespace values', () => {
    const settings = principalAssertionSettingsFrom({
      mode: 'warn',
      ttlSec: 60,
      signingKey: {
        keyId: 'k1',
        pem: edge.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      },
      publicKeys: [
        { keyId: 'k1', pem: edge.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      ],
    });
    expect(settings.mode).toBe('warn');
    expect(settings.signingKey?.ttlSec).toBe(60);
    const token = signPrincipalAssertion(caller, settings.signingKey ?? signingKey, NOW);
    expect(verifyPrincipalAssertion(token, settings.publicKeys, NOW).outcome).toBe('valid');
  });

  it('caps the metadata value: an oversized assertion is not sent', () => {
    const metadata = createOutgoingMetadata({ ...caller, principalAssertion: 'a'.repeat(5000) });
    expect(metadata.get(GRPC_METADATA_KEYS.PRINCIPAL_ASSERTION)).toEqual([]);
    expect(
      createOutgoingMetadata({ ...caller, principalAssertion: 'a.b.c' }).get(
        'x-principal-assertion',
      ),
    ).toEqual(['a.b.c']);
    expect(new Metadata().get('x-principal-assertion')).toEqual([]);
  });
});
