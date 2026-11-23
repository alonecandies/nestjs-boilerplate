import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { Metadata } from '@grpc/grpc-js';
import {
  assertedCallerOf,
  createOutgoingMetadata,
  type RpcCallerContext,
} from '../grpc/grpc-metadata.js';
import {
  type PrincipalAssertionSigningKey,
  signPrincipalAssertion,
} from '../grpc/grpc-principal-assertion.js';

export interface TestPrincipalSignOptions {
  /** When the assertion is signed (default now): in the past for a late or an expired one. */
  readonly nowMs?: number;
}

/** A throwaway edge key pair for tests that play the gateway against a verifying service. */
export interface TestPrincipalSigner {
  readonly keyId: string;
  readonly signingKey: PrincipalAssertionSigningKey;
  /** The verifier's keys, for `configurePrincipalAssertions`. */
  readonly publicKeys: ReadonlyMap<string, KeyObject>;
  /** The same key as a `GRPC_PRINCIPAL_PUBLIC_KEYS` value (`kid=base64 PEM`). */
  readonly publicKeysEnv: string;
  /** Signs exactly the caller `createOutgoingMetadata(caller)` puts in plain metadata. */
  sign(caller: RpcCallerContext, options?: TestPrincipalSignOptions): string;
  /** Plain caller metadata plus its signed `x-principal-assertion`, as the edge sends them. */
  metadata(caller: RpcCallerContext, options?: TestPrincipalSignOptions): Metadata;
}

/**
 * A new ES256 (P-256) key pair, so a test signs principal assertions the way the edge does without
 * a key file. Every call makes another pair: an assertion from one signer is "another key" to the
 * verifier of a second one.
 */
export function createTestPrincipalSigner(keyId = 'test-edge', ttlSec = 120): TestPrincipalSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signingKey: PrincipalAssertionSigningKey = { keyId, privateKey, ttlSec };
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const sign = (caller: RpcCallerContext, options: TestPrincipalSignOptions = {}): string => {
    const asserted = assertedCallerOf(caller);
    if (asserted === undefined) throw new Error('An anonymous caller has no principal to sign');
    return signPrincipalAssertion(asserted, signingKey, options.nowMs);
  };
  return {
    keyId,
    signingKey,
    publicKeys: new Map([[keyId, publicKey]]),
    publicKeysEnv: `${keyId}=${Buffer.from(publicPem).toString('base64')}`,
    sign,
    metadata: (caller, options) =>
      createOutgoingMetadata({ ...caller, principalAssertion: sign(caller, options) }),
  };
}
