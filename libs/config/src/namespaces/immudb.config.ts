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

const HOST_PORT = /^[A-Za-z0-9.-]+:\d{1,5}$/;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const PEM_PUBLIC_KEY = /-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----/;

const decodePem = (base64: string): string => Buffer.from(base64, 'base64').toString('utf8');

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
    IMMUDB_RUN_MIGRATIONS: zBool(false),
    ALLOW_KNOWN_LOCAL_SECRETS: zBool(false),
  })
  .superRefine((env, ctx) => {
    const key = env.IMMUDB_SERVER_SIGNING_PUBLIC_KEY;
    if (key !== undefined && !PEM_PUBLIC_KEY.test(decodePem(key))) {
      ctx.addIssue({
        code: 'custom',
        path: ['IMMUDB_SERVER_SIGNING_PUBLIC_KEY'],
        message: 'Expected the base64 encoding of a PEM "PUBLIC KEY" block',
      });
    }
    if (env.NODE_ENV !== 'production') return;
    if (!env.ALLOW_KNOWN_LOCAL_SECRETS) {
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
    serverSigningPublicKeyPem:
      env.IMMUDB_SERVER_SIGNING_PUBLIC_KEY === undefined
        ? undefined
        : decodePem(env.IMMUDB_SERVER_SIGNING_PUBLIC_KEY),
    runMigrations: env.IMMUDB_RUN_MIGRATIONS,
  }));

/** immudb (append-only, verifiable SQL store) over gRPC. */
export const immudbConfig = defineConfigNamespace('immudb', immudbEnvSchema);
export type ImmudbConfig = ConfigType<typeof immudbConfig>;
