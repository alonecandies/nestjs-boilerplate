import { readFileSync } from 'node:fs';
import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zInt, zNodeEnv, zStr } from '../env/env.helpers.js';
import { addKnownLocalSecretIssue, isKnownLocalSecret } from '../env/production-guards.js';

/** immudb's built-in superuser password (public knowledge): refused in production. */
export const IMMUDB_DEFAULT_ADMIN_PASSWORD = 'immudb';
/**
 * Local default of the application user. It satisfies immudb's password policy (8-32 chars, an
 * uppercase letter, a digit and a symbol) and matches `isKnownLocalSecret`, so production refuses it.
 */
export const IMMUDB_LOCAL_PASSWORD = 'Compose-local-App1!';

/**
 * First words of the comment line the compose `immudb-keygen` job writes above the generated
 * development public key. The key itself is generated at start (no private key is committed), so
 * this marker is what production recognises and refuses; it also matches `isKnownLocalSecret`.
 */
export const IMMUDB_DEV_SIGNING_PUBLIC_KEY_MARKER = 'compose-local development signing key';

const HOST_PORT = /^[A-Za-z0-9.-]+:\d{1,5}$/;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const PEM_PUBLIC_KEY = /-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----/;

const decodePem = (base64: string): string => Buffer.from(base64, 'base64').toString('utf8');

interface SigningKeyEnv {
  readonly IMMUDB_SERVER_SIGNING_PUBLIC_KEY?: string | undefined;
  readonly IMMUDB_SERVER_SIGNING_PUBLIC_KEY_FILE?: string | undefined;
}

type SigningKey =
  | { readonly kind: 'none' }
  | { readonly kind: 'pem'; readonly pem: string; readonly key: string }
  | { readonly kind: 'invalid'; readonly key: string; readonly message: string };

/**
 * The pinned state-signing public key: the base64 PEM of `IMMUDB_SERVER_SIGNING_PUBLIC_KEY`, or the
 * content of the file named by `IMMUDB_SERVER_SIGNING_PUBLIC_KEY_FILE` (a PEM, or its base64; the
 * compose stack mounts the generated key this way). The file is read at boot, once per parse.
 */
function resolveSigningKey(env: SigningKeyEnv): SigningKey {
  const inline = env.IMMUDB_SERVER_SIGNING_PUBLIC_KEY;
  const file = env.IMMUDB_SERVER_SIGNING_PUBLIC_KEY_FILE;
  if (inline !== undefined && file !== undefined) {
    return {
      kind: 'invalid',
      key: 'IMMUDB_SERVER_SIGNING_PUBLIC_KEY_FILE',
      message:
        'Set IMMUDB_SERVER_SIGNING_PUBLIC_KEY or IMMUDB_SERVER_SIGNING_PUBLIC_KEY_FILE, not both',
    };
  }
  if (file !== undefined) {
    const key = 'IMMUDB_SERVER_SIGNING_PUBLIC_KEY_FILE';
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      return { kind: 'invalid', key, message: 'The signing public key file cannot be read' };
    }
    const pem = content.includes('-----BEGIN') ? content : decodePem(content.trim());
    return PEM_PUBLIC_KEY.test(pem)
      ? { kind: 'pem', pem, key }
      : { kind: 'invalid', key, message: 'Expected a PEM "PUBLIC KEY" block (or its base64)' };
  }
  if (inline === undefined) return { kind: 'none' };
  const key = 'IMMUDB_SERVER_SIGNING_PUBLIC_KEY';
  const pem = decodePem(inline);
  return PEM_PUBLIC_KEY.test(pem)
    ? { kind: 'pem', pem, key }
    : { kind: 'invalid', key, message: 'Expected the base64 encoding of a PEM "PUBLIC KEY" block' };
}

const pinnedPem = (env: SigningKeyEnv): string | undefined => {
  const signing = resolveSigningKey(env);
  return signing.kind === 'pem' ? signing.pem : undefined;
};

export const immudbEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    IMMUDB_ADDRESS: zStr('localhost:3322', {
      pattern: HOST_PORT,
      patternMessage: 'Expected host:port, e.g. localhost:3322',
    }),
    // Interpolated into CREATE DATABASE / user provisioning → strict identifiers only.
    IMMUDB_DATABASE: zStr('app', {
      pattern: IDENTIFIER,
      patternMessage: 'Expected a lowercase identifier ([a-z][a-z0-9_]*, max 63 chars)',
    }),
    IMMUDB_USERNAME: zStr('app_writer', {
      pattern: IDENTIFIER,
      patternMessage: 'Expected a lowercase identifier ([a-z][a-z0-9_]*, max 63 chars)',
    }),
    IMMUDB_PASSWORD: zStr(IMMUDB_LOCAL_PASSWORD),
    // Provisioning and migrations only (the migrate step or IMMUDB_RUN_MIGRATIONS).
    IMMUDB_ADMIN_USERNAME: zStr('immudb'),
    IMMUDB_ADMIN_PASSWORD: zStr(),
    IMMUDB_SESSION_POOL_SIZE: zInt(4, { min: 1, max: 64 }),
    IMMUDB_TIMEOUT_MS: zInt(5_000, { min: 100 }),
    // Must stay below the server's --max-session-inactivity-time (default 3 min).
    IMMUDB_KEEPALIVE_INTERVAL_MS: zInt(60_000, { min: 1_000, max: 170_000 }),
    IMMUDB_TLS: zBool(false),
    // Production refuses plaintext gRPC without it (a mesh encrypts the hop, or the compose stack).
    IMMUDB_ALLOW_INSECURE: zBool(false),
    // base64 of the PEM public key matching the server's --signingKey (state signatures).
    IMMUDB_SERVER_SIGNING_PUBLIC_KEY: zStr(),
    // The same key as a file (a PEM or its base64), e.g. a mounted secret or the compose volume.
    IMMUDB_SERVER_SIGNING_PUBLIC_KEY_FILE: zStr(),
    IMMUDB_RUN_MIGRATIONS: zBool(false),
    ALLOW_KNOWN_LOCAL_SECRETS: zBool(false),
  })
  .superRefine((env, ctx) => {
    const signing = resolveSigningKey(env);
    if (signing.kind === 'invalid') {
      ctx.addIssue({ code: 'custom', path: [signing.key], message: signing.message });
    }
    if (env.NODE_ENV !== 'production') return;
    if (!env.ALLOW_KNOWN_LOCAL_SECRETS) {
      // The development key of the compose stack (generated, marked): never pinned in production.
      if (signing.kind === 'pem' && isKnownLocalSecret(signing.pem)) {
        addKnownLocalSecretIssue(ctx, signing.key);
      }
      if (isKnownLocalSecret(env.IMMUDB_PASSWORD)) addKnownLocalSecretIssue(ctx, 'IMMUDB_PASSWORD');
      const admin = env.IMMUDB_ADMIN_PASSWORD;
      if (admin === IMMUDB_DEFAULT_ADMIN_PASSWORD || isKnownLocalSecret(admin)) {
        addKnownLocalSecretIssue(ctx, 'IMMUDB_ADMIN_PASSWORD');
      }
    }
    if (!env.IMMUDB_TLS && !env.IMMUDB_ALLOW_INSECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['IMMUDB_TLS'],
        message:
          'immudb credentials and data would travel unencrypted: set IMMUDB_TLS=true in production, or IMMUDB_ALLOW_INSECURE=true when the network layer secures it',
      });
    }
  })
  .transform((env) => ({
    address: env.IMMUDB_ADDRESS,
    database: env.IMMUDB_DATABASE,
    credentials: { username: env.IMMUDB_USERNAME, password: env.IMMUDB_PASSWORD },
    /** Superuser for provisioning/migrations; `undefined` = this process never provisions. */
    admin:
      env.IMMUDB_ADMIN_PASSWORD === undefined
        ? undefined
        : { username: env.IMMUDB_ADMIN_USERNAME, password: env.IMMUDB_ADMIN_PASSWORD },
    sessionPoolSize: env.IMMUDB_SESSION_POOL_SIZE,
    timeoutMs: env.IMMUDB_TIMEOUT_MS,
    keepAliveIntervalMs: env.IMMUDB_KEEPALIVE_INTERVAL_MS,
    tls: env.IMMUDB_TLS,
    serverSigningPublicKeyPem: pinnedPem(env),
    runMigrations: env.IMMUDB_RUN_MIGRATIONS,
  }));

/** immudb (append-only, verifiable SQL store) over gRPC. */
export const immudbConfig = defineConfigNamespace('immudb', immudbEnvSchema);
export type ImmudbConfig = ConfigType<typeof immudbConfig>;
