import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from 'node:crypto';
import { type GrpcConfig, type GrpcPrincipalAssertionMode, grpcConfig } from '@platform/config';
import { getOrCreateCounter } from '@platform/observability';
import { isEqual, sortBy } from 'lodash-es';
import { z } from 'zod';
import type { AssertedCaller, IncomingRpcContext } from './grpc-metadata.js';

/**
 * The principal assertion (spec: grpc-principal-unsigned, warn mode). The edge (the gateway) signs
 * the caller it forwards in plain metadata with an ES256 private key only it holds; services verify
 * it with the public keys (`GRPC_PRINCIPAL_PUBLIC_KEYS`) and forward the same bytes on their own
 * calls. Format: a compact JWS, `base64url(header).base64url(claims).base64url(signature)`, with
 * header `{ alg: 'ES256', typ: 'JWT', kid }` and claims `{ iss, sub, tid?, roles?, staff?, iat, exp }`.
 * `node:crypto` only.
 */

/** `iss` of every assertion: the edge. A token with another issuer is refused. */
export const PRINCIPAL_ASSERTION_ISSUER = 'edge';
export const GRPC_PRINCIPAL_ASSERTIONS_TOTAL = 'grpc_principal_assertions_total';
/** Clock difference tolerated between the edge and a service, on `iat` and `exp`. */
const CLOCK_SKEW_SEC = 10;
const ES256_SIGNATURE_BYTES = 64;
const MAX_TOKEN_LENGTH = 4096;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * What a verifying server counts in `grpc_principal_assertions_total{outcome}`:
 * - `valid`: signed by a known key, in date, and equal to the plain headers;
 * - `missing`: a user in plain headers and no assertion (an old gateway or ai-service);
 * - `expired`: a valid signature past `exp`;
 * - `invalid`: malformed, an unknown key id, a bad signature, another alg or issuer;
 * - `mismatch`: valid, but the plain headers assert another user, tenant, roles or staff flag.
 */
export type PrincipalAssertionOutcome = 'valid' | 'missing' | 'expired' | 'invalid' | 'mismatch';

export interface PrincipalAssertionSigningKey {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  /** Lifetime of each assertion (`GRPC_PRINCIPAL_ASSERTION_TTL_SEC`). */
  readonly ttlSec: number;
}

/** The process-wide settings, from the `grpc` namespace (`principalAssertionSettingsFrom`). */
export interface PrincipalAssertionSettings {
  /** Verifier side: `off` ignores the header, `warn` verifies, logs and counts. */
  readonly mode: GrpcPrincipalAssertionMode;
  /** Edge only: present when this process may sign (`GRPC_PRINCIPAL_SIGNING_KEY`). */
  readonly signingKey?: PrincipalAssertionSigningKey | undefined;
  /** Accepted public keys by key id: several during a rotation. */
  readonly publicKeys: ReadonlyMap<string, KeyObject>;
}

export type PrincipalAssertionVerification =
  | { readonly outcome: 'valid'; readonly caller: AssertedCaller }
  | { readonly outcome: 'expired' | 'invalid' };

const headerSchema = z.object({ alg: z.literal('ES256'), kid: z.string().min(1).max(64) });
/** Unknown claims are ignored, so a newer edge may add some without breaking older services. */
const claimsSchema = z.object({
  iss: z.literal(PRINCIPAL_ASSERTION_ISSUER),
  sub: z.string().min(1).max(256),
  tid: z.string().min(1).max(256).optional(),
  roles: z.array(z.string().max(256)).max(32).optional(),
  staff: z.boolean().optional(),
  iat: z.number().int(),
  exp: z.number().int(),
});

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

function decode(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Signs `caller` (as `assertedCallerOf` built it) for `key.ttlSec` seconds from `nowMs`. */
export function signPrincipalAssertion(
  caller: AssertedCaller,
  key: PrincipalAssertionSigningKey,
  nowMs: number = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const claims = {
    iss: PRINCIPAL_ASSERTION_ISSUER,
    sub: caller.userId,
    ...(caller.tenantId === undefined ? {} : { tid: caller.tenantId }),
    ...(caller.roles.length === 0 ? {} : { roles: caller.roles }),
    ...(caller.staff ? { staff: true } : {}),
    iat,
    exp: iat + key.ttlSec,
  };
  const input = `${encode({ alg: 'ES256', typ: 'JWT', kid: key.keyId })}.${encode(claims)}`;
  const signature = sign('sha256', Buffer.from(input), {
    key: key.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${input}.${signature.toString('base64url')}`;
}

/**
 * Verifies a token: ES256 only, the key looked up by `kid` (never every key in turn), the signature
 * checked before any claim is read, then the issuer and the dates. Never throws.
 */
export function verifyPrincipalAssertion(
  token: string,
  publicKeys: ReadonlyMap<string, KeyObject>,
  nowMs: number = Date.now(),
): PrincipalAssertionVerification {
  const invalid = { outcome: 'invalid' } as const;
  if (token.length > MAX_TOKEN_LENGTH || !COMPACT_JWS.test(token)) return invalid;
  const [headerPart = '', claimsPart = '', signaturePart = ''] = token.split('.');
  const header = headerSchema.safeParse(decode(headerPart));
  if (!header.success) return invalid;
  const key = publicKeys.get(header.data.kid);
  if (key === undefined) return invalid;
  const signature = Buffer.from(signaturePart, 'base64url');
  if (signature.length !== ES256_SIGNATURE_BYTES) return invalid;
  let signed = false;
  try {
    signed = verify(
      'sha256',
      Buffer.from(`${headerPart}.${claimsPart}`),
      { key, dsaEncoding: 'ieee-p1363' },
      signature,
    );
  } catch {
    signed = false;
  }
  if (!signed) return invalid;
  const claims = claimsSchema.safeParse(decode(claimsPart));
  if (!claims.success) return invalid;
  const { sub, tid, roles, staff, iat, exp } = claims.data;
  const now = nowMs / 1000;
  if (exp <= iat || iat > now + CLOCK_SKEW_SEC) return invalid;
  if (now > exp + CLOCK_SKEW_SEC) return { outcome: 'expired' };
  return {
    outcome: 'valid',
    caller: {
      userId: sub,
      ...(tid === undefined ? {} : { tenantId: tid }),
      roles: roles ?? [],
      staff: staff === true,
    },
  };
}

const sameCaller = (signed: AssertedCaller, plain: IncomingRpcContext): boolean =>
  signed.userId === plain.userId &&
  signed.tenantId === plain.tenantId &&
  signed.staff === plain.staff &&
  isEqual(sortBy(signed.roles), sortBy(plain.roles));

/**
 * The outcome for one incoming call, or `undefined` for an anonymous call without an assertion
 * (register, login, a signed webhook): those need none, so they are not counted.
 */
export function checkPrincipalAssertion(
  caller: IncomingRpcContext,
  publicKeys: ReadonlyMap<string, KeyObject>,
  nowMs: number = Date.now(),
): PrincipalAssertionOutcome | undefined {
  if (caller.principalAssertion === undefined) {
    return caller.userId === undefined ? undefined : 'missing';
  }
  const verification = verifyPrincipalAssertion(caller.principalAssertion, publicKeys, nowMs);
  if (verification.outcome !== 'valid') return verification.outcome;
  return sameCaller(verification.caller, caller) ? 'valid' : 'mismatch';
}

/** Counts one verified call in `grpc_principal_assertions_total{outcome}`. */
export function recordPrincipalAssertion(outcome: PrincipalAssertionOutcome): void {
  getOrCreateCounter({
    name: GRPC_PRINCIPAL_ASSERTIONS_TOTAL,
    help: 'gRPC calls by the outcome of their signed principal assertion (valid, missing, expired, invalid, mismatch)',
    labelNames: ['outcome'],
  }).inc({ outcome });
}

/** Key objects for the `grpc` namespace's `principalAssertion` (PEMs validated at boot). */
export function principalAssertionSettingsFrom(
  config: GrpcConfig['principalAssertion'],
): PrincipalAssertionSettings {
  const { signingKey } = config;
  return {
    mode: config.mode,
    signingKey:
      signingKey === undefined
        ? undefined
        : {
            keyId: signingKey.keyId,
            privateKey: createPrivateKey(signingKey.pem),
            ttlSec: config.ttlSec,
          },
    publicKeys: new Map(config.publicKeys.map((key) => [key.keyId, createPublicKey(key.pem)])),
  };
}

let fromEnvironment: PrincipalAssertionSettings | undefined;
let override: PrincipalAssertionSettings | undefined;

/**
 * This process's settings: parsed once from the environment with the `grpc` namespace's schema
 * (every app validated it at boot), unless `configurePrincipalAssertions` replaced them. Read on
 * every call by `callerContextFromCls` (signing, edge) and `GrpcContextInterceptor` (verifying).
 */
export function principalAssertionSettings(): PrincipalAssertionSettings {
  if (override !== undefined) return override;
  fromEnvironment ??= principalAssertionSettingsFrom(grpcConfig.parse().principalAssertion);
  return fromEnvironment;
}

/**
 * Replaces the settings for this process (tests, or one process playing several roles);
 * `undefined` returns to the environment's.
 */
export function configurePrincipalAssertions(
  settings: PrincipalAssertionSettings | undefined,
): void {
  override = settings;
}
