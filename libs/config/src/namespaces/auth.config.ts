import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zInt, zNodeEnv, zStr } from '../env/env.helpers.js';
import { addKnownLocalSecretIssue, isKnownLocalSecret } from '../env/production-guards.js';

/** Development-only default so `bun run dev` works with zero `.env`. Rejected in production. */
export const DEV_JWT_ACCESS_SECRET = 'dev-access-secret-change-me-please-32chars';

/** Every HS256 JWT secret (access and refresh) is at least this long, in every environment. */
export const MIN_JWT_SECRET_LENGTH = 32;

/** A JWT key id (`kid` header): 1-64 letters, digits, `.`, `_` or `-`. */
export const JWT_KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * A verify-only HS256 key (`JWT_ACCESS_VERIFY_SECRETS`, `JWT_REFRESH_VERIFY_SECRETS`): a token whose
 * `kid` header names it verifies with it, and a token without `kid` may (secret rotation, SEC-1).
 */
export interface JwtVerifyKey {
  readonly kid: string;
  readonly secret: string;
}

/**
 * `kid:secret, kid:secret` → its entries, split on each entry's first `:` and trimmed (empty
 * entries dropped; an entry with no `:` has an empty `kid`). Not validated: see
 * `checkJwtVerifySecrets`.
 */
export function splitJwtVerifySecrets(raw: string | undefined): JwtVerifyKey[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const colon = entry.indexOf(':');
      return colon < 0
        ? { kid: '', secret: entry }
        : { kid: entry.slice(0, colon).trim(), secret: entry.slice(colon + 1).trim() };
    });
}

export interface JwtVerifySecretsRules {
  /** The variable holding the list (`JWT_ACCESS_VERIFY_SECRETS`, `JWT_REFRESH_VERIFY_SECRETS`). */
  readonly key: string;
  /** The signing key's variable and value (`JWT_ACCESS_KEY_ID`): no entry may reuse it. */
  readonly signingKeyIdKey: string;
  readonly signingKeyId: string | undefined;
  /** Production only: refused even with `ALLOW_KNOWN_LOCAL_SECRETS`. */
  readonly devDefaults: readonly string[];
  readonly production: boolean;
  readonly allowKnownLocalSecrets: boolean;
}

/**
 * The guards of a signing secret, applied to every entry of a verify-only list: a well-formed and
 * unique `kid`, at least `MIN_JWT_SECRET_LENGTH` characters (every environment), and in production
 * no development default and no publicly known value. Messages name the entry by position: they
 * never echo a secret or a key id.
 */
export function checkJwtVerifySecrets(
  ctx: z.RefinementCtx,
  raw: string | undefined,
  rules: JwtVerifySecretsRules,
): void {
  const issue = (message: string): void => {
    ctx.addIssue({ code: 'custom', path: [rules.key], message: `${rules.key} ${message}` });
  };
  const seen = new Set<string>();
  splitJwtVerifySecrets(raw).forEach(({ kid, secret }, index) => {
    const entry = `entry ${index + 1}`;
    if (!JWT_KEY_ID_PATTERN.test(kid) || secret.length === 0) {
      issue(`${entry} must be kid:secret, kid being 1-64 letters, digits, ".", "_" or "-"`);
      return;
    }
    if (kid === rules.signingKeyId) {
      issue(`${entry} reuses the key id of ${rules.signingKeyIdKey}`);
    } else if (seen.has(kid)) {
      issue(`${entry} repeats the key id of an earlier entry`);
    }
    seen.add(kid);
    if (secret.length < MIN_JWT_SECRET_LENGTH) {
      issue(`${entry}: the secret must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
    }
    if (!rules.production) return;
    if (rules.devDefaults.includes(secret)) {
      issue(`${entry} is a development default, which is not allowed in production`);
    } else if (!rules.allowKnownLocalSecrets && isKnownLocalSecret(secret)) {
      addKnownLocalSecretIssue(ctx, rules.key);
    }
  });
}

/** `zStr` options of a key id variable (`JWT_ACCESS_KEY_ID`, `JWT_REFRESH_KEY_ID`). */
export const JWT_KEY_ID_FORMAT = {
  pattern: JWT_KEY_ID_PATTERN,
  patternMessage: 'Expected 1-64 letters, digits, ".", "_" or "-"',
} as const;

export const authEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    JWT_ACCESS_SECRET: zStr(DEV_JWT_ACCESS_SECRET, { min: MIN_JWT_SECRET_LENGTH }),
    // Written as the `kid` header of new access tokens when set.
    JWT_ACCESS_KEY_ID: zStr(undefined, JWT_KEY_ID_FORMAT),
    // Verify-only `kid:secret` keys, comma-separated: the rotation window (SEC-1).
    JWT_ACCESS_VERIFY_SECRETS: zStr(),
    JWT_ACCESS_TTL_SEC: zInt(900, { min: 1 }),
    JWT_ISSUER: zStr('nestjs-boilerplate'),
    JWT_AUDIENCE: zStr('nestjs-boilerplate'),
    AUTH_DENYLIST_ENABLED: zBool(true),
    // How often each replica closes its WebSockets (Socket.IO and graphql-ws) whose token was revoked.
    WS_REVOCATION_SWEEP_INTERVAL_MS: zInt(30_000, { min: 100, max: 300_000 }),
    // LOCAL compose stack only: accept the publicly known compose fallbacks in production mode.
    ALLOW_KNOWN_LOCAL_SECRETS: zBool(false),
  })
  .superRefine((env, ctx) => {
    checkJwtVerifySecrets(ctx, env.JWT_ACCESS_VERIFY_SECRETS, {
      key: 'JWT_ACCESS_VERIFY_SECRETS',
      signingKeyIdKey: 'JWT_ACCESS_KEY_ID',
      signingKeyId: env.JWT_ACCESS_KEY_ID,
      devDefaults: [DEV_JWT_ACCESS_SECRET],
      production: env.NODE_ENV === 'production',
      allowKnownLocalSecrets: env.ALLOW_KNOWN_LOCAL_SECRETS,
    });
    if (env.NODE_ENV !== 'production') return;
    const devDefaults = {
      JWT_ACCESS_SECRET: DEV_JWT_ACCESS_SECRET,
    } as const;
    for (const [key, devValue] of Object.entries(devDefaults) as [
      keyof typeof devDefaults,
      string,
    ][]) {
      if (env[key] === devValue) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} must be set to a strong, unique secret in production (the development default is not allowed)`,
        });
      } else if (!env.ALLOW_KNOWN_LOCAL_SECRETS && isKnownLocalSecret(env[key])) {
        addKnownLocalSecretIssue(ctx, key);
      }
    }
    // The refresh secrets (dev default, known values, disjoint from these ones) are guarded by the
    // issuer's own `refreshToken` namespace.
  })
  .transform((env) => ({
    accessSecret: env.JWT_ACCESS_SECRET,
    accessKeyId: env.JWT_ACCESS_KEY_ID,
    accessVerifyKeys: splitJwtVerifySecrets(env.JWT_ACCESS_VERIFY_SECRETS),
    accessTtlSec: env.JWT_ACCESS_TTL_SEC,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    denylistEnabled: env.AUTH_DENYLIST_ENABLED,
    wsRevocationSweepIntervalMs: env.WS_REVOCATION_SWEEP_INTERVAL_MS,
  }));

/**
 * Access tokens: the signing secret, its key id and TTL (signer side), the verify-only keys,
 * `iss`/`aud`, the denylist and the WebSocket revocation sweep interval (every verifier).
 */
export const authConfig = defineConfigNamespace('auth', authEnvSchema);
export type AuthConfig = ConfigType<typeof authConfig>;
