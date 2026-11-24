import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zEnum, zInt, zNodeEnv, zStr } from '../env/env.helpers.js';
import { addKnownLocalSecretIssue, isKnownLocalSecret } from '../env/production-guards.js';

/**
 * `off`: the assertion header is ignored. `warn`: verified, logged and counted, never refused.
 * `enforce`: a call with a user needs a valid assertion, whose claims alone build the principal.
 */
export const GRPC_PRINCIPAL_ASSERTION_MODES = ['off', 'warn', 'enforce'] as const;
export type GrpcPrincipalAssertionMode = (typeof GRPC_PRINCIPAL_ASSERTION_MODES)[number];

/**
 * The longest lifetime of a signed principal assertion (`GRPC_PRINCIPAL_ASSERTION_TTL_SEC`'s
 * maximum). A verifier refuses a token whose `exp - iat` exceeds it, so no gateway, old or new, ever
 * signs one that is refused, and a leaked assertion cannot have been minted for longer.
 */
export const GRPC_PRINCIPAL_ASSERTION_MAX_TTL_SEC = 3600;

/** One key of the principal assertion: its id (the JWS `kid`) and its PEM. */
export interface GrpcPrincipalKey {
  readonly keyId: string;
  readonly pem: string;
}

const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const PEM_PUBLIC_KEY = /-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----/;

type Resolved<T> =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly value: T; readonly key: string; readonly text: string }
  | { readonly kind: 'invalid'; readonly key: string; readonly message: string };

/** The env value, or the content of its `_FILE` variant (read once per parse). */
function readVariant(
  inline: string | undefined,
  file: string | undefined,
  name: string,
): Resolved<string> {
  if (inline !== undefined && file !== undefined) {
    return {
      kind: 'invalid',
      key: `${name}_FILE`,
      message: `Set ${name} or ${name}_FILE, not both`,
    };
  }
  if (file !== undefined) {
    try {
      const text = readFileSync(file, 'utf8');
      return { kind: 'ok', value: text, key: `${name}_FILE`, text };
    } catch {
      return {
        kind: 'invalid',
        key: `${name}_FILE`,
        message: `The ${name}_FILE file cannot be read`,
      };
    }
  }
  return inline === undefined
    ? { kind: 'none' }
    : { kind: 'ok', value: inline, key: name, text: inline };
}

const decodePem = (value: string): string =>
  value.includes('-----BEGIN') ? value : Buffer.from(value.trim(), 'base64').toString('utf8');

/** ES256 needs a P-256 (prime256v1) EC key. */
const isP256 = (key: KeyObject): boolean =>
  key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';

function parseSigningKey(raw: string, key: string): Resolved<string> {
  const pem = decodePem(raw);
  try {
    if (isP256(createPrivateKey(pem))) return { kind: 'ok', value: pem, key, text: pem };
  } catch {
    // reported below without echoing the value
  }
  return {
    kind: 'invalid',
    key,
    message: 'Expected a P-256 (ES256) private key PEM, or its base64',
  };
}

/**
 * `kid=base64 PEM` entries, separated by commas or whitespace (a file holds one per line; lines
 * starting with `#` are comments). Only `PUBLIC KEY` blocks on P-256: a private key never belongs here.
 */
function parsePublicKeys(raw: string, key: string): Resolved<GrpcPrincipalKey[]> {
  const body = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  const keys: GrpcPrincipalKey[] = [];
  for (const entry of body.split(/[\s,]+/).filter((part) => part.length > 0)) {
    const at = entry.indexOf('=');
    const keyId = at === -1 ? '' : entry.slice(0, at);
    if (!KEY_ID.test(keyId)) {
      return {
        kind: 'invalid',
        key,
        message: 'Expected kid=base64 PEM entries ([A-Za-z0-9._-] ids)',
      };
    }
    if (keys.some((known) => known.keyId === keyId)) {
      return { kind: 'invalid', key, message: `Key id "${keyId}" is listed twice` };
    }
    const pem = decodePem(entry.slice(at + 1));
    let valid = false;
    try {
      valid = PEM_PUBLIC_KEY.test(pem) && isP256(createPublicKey(pem));
    } catch {
      valid = false;
    }
    if (!valid) {
      return {
        kind: 'invalid',
        key,
        message: `Key "${keyId}" is not the base64 of a P-256 (ES256) "PUBLIC KEY" PEM`,
      };
    }
    keys.push({ keyId, pem });
  }
  return { kind: 'ok', value: keys, key, text: raw };
}

interface PrincipalEnv {
  readonly GRPC_PRINCIPAL_SIGNING_KEY?: string | undefined;
  readonly GRPC_PRINCIPAL_SIGNING_KEY_FILE?: string | undefined;
  readonly GRPC_PRINCIPAL_PUBLIC_KEYS?: string | undefined;
  readonly GRPC_PRINCIPAL_PUBLIC_KEYS_FILE?: string | undefined;
}

function resolveSigningKey(env: PrincipalEnv): Resolved<string> {
  const raw = readVariant(
    env.GRPC_PRINCIPAL_SIGNING_KEY,
    env.GRPC_PRINCIPAL_SIGNING_KEY_FILE,
    'GRPC_PRINCIPAL_SIGNING_KEY',
  );
  return raw.kind === 'ok' ? parseSigningKey(raw.value, raw.key) : raw;
}

function resolvePublicKeys(env: PrincipalEnv): Resolved<GrpcPrincipalKey[]> {
  const raw = readVariant(
    env.GRPC_PRINCIPAL_PUBLIC_KEYS,
    env.GRPC_PRINCIPAL_PUBLIC_KEYS_FILE,
    'GRPC_PRINCIPAL_PUBLIC_KEYS',
  );
  return raw.kind === 'ok' ? parsePublicKeys(raw.value, raw.key) : raw;
}

export const grpcEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    GRPC_URL: zStr('0.0.0.0:50051'),
    GRPC_DEADLINE_MS: zInt(5000, { min: 1 }),
    GRPC_MAX_MESSAGE_BYTES: zInt(4_194_304, { min: 1024 }),
    // TLS for internal gRPC (PEM files). CERT + KEY switch it on, for the server AND as the client
    // certificate this process presents (mTLS). CA = the bundle that signed the PEERS' certificates.
    GRPC_TLS_CA_PATH: zStr(),
    GRPC_TLS_CERT_PATH: zStr(),
    GRPC_TLS_KEY_PATH: zStr(),
    GRPC_TLS_REQUIRE_CLIENT_CERT: zBool(true),
    // Production refuses plaintext gRPC unless this explicit opt-out is set (e.g. a service mesh
    // already encrypts and authenticates pod-to-pod traffic).
    GRPC_ALLOW_INSECURE: zBool(false),
    // Server reflection (grpcurl/Postman). Default: on unless NODE_ENV=production.
    GRPC_REFLECTION: zBool(),
    // Signed principal assertion (x-principal-assertion): off | warn | enforce.
    GRPC_PRINCIPAL_ASSERTION: zEnum(GRPC_PRINCIPAL_ASSERTION_MODES, 'off'),
    // The edge's ES256 private key (base64 of a P-256 PEM), or a file holding it; edge only.
    GRPC_PRINCIPAL_SIGNING_KEY: zStr(),
    GRPC_PRINCIPAL_SIGNING_KEY_FILE: zStr(),
    GRPC_PRINCIPAL_SIGNING_KEY_ID: zStr(undefined, {
      pattern: KEY_ID,
      patternMessage: 'Expected [A-Za-z0-9._-], max 64 chars',
    }),
    // The verifiers' public keys: kid=base64 PEM, comma-separated (or a file, one per line).
    GRPC_PRINCIPAL_PUBLIC_KEYS: zStr(),
    GRPC_PRINCIPAL_PUBLIC_KEYS_FILE: zStr(),
    // Lifetime of a signed assertion; keep it above the longest gRPC deadline (AI_GRPC_CHAT_DEADLINE_MS).
    GRPC_PRINCIPAL_ASSERTION_TTL_SEC: zInt(120, {
      min: 10,
      max: GRPC_PRINCIPAL_ASSERTION_MAX_TTL_SEC,
    }),
    ALLOW_KNOWN_LOCAL_SECRETS: zBool(false),
  })
  // One transform, not a refinement plus a transform: the key files are read and parsed once per
  // parse, and that one result feeds both the checks and the value.
  .transform((env, ctx) => {
    const signing = resolveSigningKey(env);
    const verifying = resolvePublicKeys(env);
    const issuesBefore = ctx.issues.length;
    for (const resolved of [signing, verifying]) {
      if (resolved.kind === 'invalid') {
        ctx.addIssue({ code: 'custom', path: [resolved.key], message: resolved.message });
      }
    }
    if ((signing.kind !== 'none') !== (env.GRPC_PRINCIPAL_SIGNING_KEY_ID !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['GRPC_PRINCIPAL_SIGNING_KEY_ID'],
        message:
          'GRPC_PRINCIPAL_SIGNING_KEY (or _FILE) and GRPC_PRINCIPAL_SIGNING_KEY_ID must be set together',
      });
    }
    if (
      env.GRPC_PRINCIPAL_ASSERTION !== 'off' &&
      (verifying.kind !== 'ok' || verifying.value.length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['GRPC_PRINCIPAL_PUBLIC_KEYS'],
        message: `GRPC_PRINCIPAL_ASSERTION=${env.GRPC_PRINCIPAL_ASSERTION} needs GRPC_PRINCIPAL_PUBLIC_KEYS (or _FILE) to verify with`,
      });
    }
    if (env.NODE_ENV === 'production' && !env.ALLOW_KNOWN_LOCAL_SECRETS) {
      // The compose stack's generated pair (kid and PEM comment line "compose-local"): never in production.
      if (isKnownLocalSecret(env.GRPC_PRINCIPAL_SIGNING_KEY_ID)) {
        addKnownLocalSecretIssue(ctx, 'GRPC_PRINCIPAL_SIGNING_KEY_ID');
      }
      if (signing.kind === 'ok' && isKnownLocalSecret(signing.text)) {
        addKnownLocalSecretIssue(ctx, signing.key);
      }
      if (
        verifying.kind === 'ok' &&
        (isKnownLocalSecret(verifying.text) ||
          verifying.value.some(
            (key) => isKnownLocalSecret(key.keyId) || isKnownLocalSecret(key.pem),
          ))
      ) {
        addKnownLocalSecretIssue(ctx, verifying.key);
      }
    }
    const hasCert = env.GRPC_TLS_CERT_PATH !== undefined;
    const hasKey = env.GRPC_TLS_KEY_PATH !== undefined;
    if (hasCert !== hasKey) {
      ctx.addIssue({
        code: 'custom',
        path: [hasCert ? 'GRPC_TLS_KEY_PATH' : 'GRPC_TLS_CERT_PATH'],
        message: 'GRPC_TLS_CERT_PATH and GRPC_TLS_KEY_PATH must be set together',
      });
    }
    if (hasCert && env.GRPC_TLS_REQUIRE_CLIENT_CERT && env.GRPC_TLS_CA_PATH === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['GRPC_TLS_CA_PATH'],
        message:
          'GRPC_TLS_CA_PATH is required to verify client certificates (or set GRPC_TLS_REQUIRE_CLIENT_CERT=false)',
      });
    }
    if (env.NODE_ENV === 'production' && !hasCert && !env.GRPC_ALLOW_INSECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['GRPC_TLS_CERT_PATH'],
        message:
          'gRPC is plaintext and unauthenticated without TLS: set GRPC_TLS_CERT_PATH/GRPC_TLS_KEY_PATH/GRPC_TLS_CA_PATH in production, or GRPC_ALLOW_INSECURE=true when the network layer (mesh, NetworkPolicy) secures it',
      });
    }
    if (ctx.issues.length > issuesBefore) return z.NEVER;
    return {
      /** Server bind address of THIS service. */
      url: env.GRPC_URL,
      /** Default per-call deadline; every client call MUST have one or a hung upstream pins resources. */
      deadlineMs: env.GRPC_DEADLINE_MS,
      maxMessageBytes: env.GRPC_MAX_MESSAGE_BYTES,
      /**
       * PEM file paths, or `undefined` for plaintext. Servers require a client certificate signed by
       * `caPath` when `requireClientCert`; clients verify servers against `caPath` (system roots when
       * unset) and present `certPath`/`keyPath`.
       */
      tls:
        env.GRPC_TLS_CERT_PATH !== undefined && env.GRPC_TLS_KEY_PATH !== undefined
          ? {
              caPath: env.GRPC_TLS_CA_PATH,
              certPath: env.GRPC_TLS_CERT_PATH,
              keyPath: env.GRPC_TLS_KEY_PATH,
              requireClientCert: env.GRPC_TLS_REQUIRE_CLIENT_CERT,
            }
          : undefined,
      /** Attach gRPC server reflection. */
      reflection: env.GRPC_REFLECTION ?? env.NODE_ENV !== 'production',
      /**
       * The signed principal assertion: `mode` (verifier side), `signingKey` (the edge only: the
       * gateway signs for its authenticated principal), `publicKeys` (every key a verifier accepts,
       * by key id) and `ttlSec`.
       */
      principalAssertion: principalAssertionOf(env, signing, verifying),
    };
  });

function principalAssertionOf(
  env: PrincipalEnv & {
    readonly GRPC_PRINCIPAL_ASSERTION: GrpcPrincipalAssertionMode;
    readonly GRPC_PRINCIPAL_SIGNING_KEY_ID?: string | undefined;
    readonly GRPC_PRINCIPAL_ASSERTION_TTL_SEC: number;
  },
  signing: Resolved<string>,
  verifying: Resolved<GrpcPrincipalKey[]>,
): {
  mode: GrpcPrincipalAssertionMode;
  ttlSec: number;
  signingKey: GrpcPrincipalKey | undefined;
  publicKeys: GrpcPrincipalKey[];
} {
  return {
    mode: env.GRPC_PRINCIPAL_ASSERTION,
    ttlSec: env.GRPC_PRINCIPAL_ASSERTION_TTL_SEC,
    signingKey:
      signing.kind === 'ok' && env.GRPC_PRINCIPAL_SIGNING_KEY_ID !== undefined
        ? { keyId: env.GRPC_PRINCIPAL_SIGNING_KEY_ID, pem: signing.value }
        : undefined,
    publicKeys: verifying.kind === 'ok' ? verifying.value : [],
  };
}

/**
 * gRPC server bind address, call deadlines, message limits, TLS, reflection and the signed principal
 * assertion. Client targets belong to the domain they reach, in its own `<x>GrpcClient` namespace
 * (e.g. `ordersGrpcClient`).
 */
export const grpcConfig = defineConfigNamespace('grpc', grpcEnvSchema);
export type GrpcConfig = ConfigType<typeof grpcConfig>;
