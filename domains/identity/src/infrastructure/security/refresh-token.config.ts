import type { ConfigType } from '@nestjs/config';
import {
  addKnownLocalSecretIssue,
  checkJwtVerifySecrets,
  DEV_JWT_ACCESS_SECRET,
  defineConfigNamespace,
  isKnownLocalSecret,
  JWT_KEY_ID_FORMAT,
  MIN_JWT_SECRET_LENGTH,
  splitJwtVerifySecrets,
  zBool,
  zInt,
  zNodeEnv,
  zStr,
} from '@platform/config';
import { z } from 'zod';

/** Development-only default so `bun run dev` works with zero `.env`. Rejected in production. */
export const DEV_JWT_REFRESH_SECRET = 'dev-refresh-secret-change-me-please-32chars';

/**
 * Identity's refresh-token settings. Only the processes that run `IdentityCoreModule` (monolith,
 * identity-service) load this namespace, so edge verifiers never hold the refresh secret. Its
 * production guards are the ones the platform `auth` namespace applies to the access secret.
 */
export const refreshTokenEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    JWT_REFRESH_SECRET: zStr(DEV_JWT_REFRESH_SECRET, { min: MIN_JWT_SECRET_LENGTH }),
    // Written as the `kid` header of new refresh tokens when set.
    JWT_REFRESH_KEY_ID: zStr(undefined, JWT_KEY_ID_FORMAT),
    // Verify-only `kid:secret` keys, comma-separated: the rotation window (SEC-1).
    JWT_REFRESH_VERIFY_SECRETS: zStr(),
    JWT_REFRESH_TTL_SEC: zInt(604_800, { min: 1 }),
    // Read only for the must-differ guard below (same default as `auth`, so the comparison sees
    // the values the access verifier uses); the `auth` namespace validates them.
    JWT_ACCESS_SECRET: zStr(DEV_JWT_ACCESS_SECRET),
    JWT_ACCESS_VERIFY_SECRETS: zStr(),
    // LOCAL compose stack only: accept the publicly known compose fallbacks in production mode.
    ALLOW_KNOWN_LOCAL_SECRETS: zBool(false),
  })
  .superRefine((env, ctx) => {
    checkJwtVerifySecrets(ctx, env.JWT_REFRESH_VERIFY_SECRETS, {
      key: 'JWT_REFRESH_VERIFY_SECRETS',
      signingKeyIdKey: 'JWT_REFRESH_KEY_ID',
      signingKeyId: env.JWT_REFRESH_KEY_ID,
      devDefaults: [DEV_JWT_REFRESH_SECRET, DEV_JWT_ACCESS_SECRET],
      production: env.NODE_ENV === 'production',
      allowKnownLocalSecrets: env.ALLOW_KNOWN_LOCAL_SECRETS,
    });
    if (env.NODE_ENV !== 'production') return;
    if (env.JWT_REFRESH_SECRET === DEV_JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message:
          'JWT_REFRESH_SECRET must be set to a strong, unique secret in production (the development default is not allowed)',
      });
    } else if (!env.ALLOW_KNOWN_LOCAL_SECRETS && isKnownLocalSecret(env.JWT_REFRESH_SECRET)) {
      addKnownLocalSecretIssue(ctx, 'JWT_REFRESH_SECRET');
    }
    // A shared secret would let a refresh token verify as an access token (and vice versa), so no
    // refresh secret, signing or verify-only, may be any access secret.
    const accessSecrets = new Set([
      env.JWT_ACCESS_SECRET,
      ...splitJwtVerifySecrets(env.JWT_ACCESS_VERIFY_SECRETS).map((key) => key.secret),
    ]);
    if (accessSecrets.has(env.JWT_REFRESH_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message:
          'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET and every JWT_ACCESS_VERIFY_SECRETS secret in production',
      });
    }
    splitJwtVerifySecrets(env.JWT_REFRESH_VERIFY_SECRETS).forEach(({ secret }, index) => {
      if (!accessSecrets.has(secret)) return;
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_VERIFY_SECRETS'],
        message: `JWT_REFRESH_VERIFY_SECRETS entry ${index + 1} must differ from JWT_ACCESS_SECRET and every JWT_ACCESS_VERIFY_SECRETS secret in production`,
      });
    });
  })
  .transform((env) => ({
    refreshSecret: env.JWT_REFRESH_SECRET,
    refreshTtlSec: env.JWT_REFRESH_TTL_SEC,
    refreshKeyId: env.JWT_REFRESH_KEY_ID,
    refreshVerifyKeys: splitJwtVerifySecrets(env.JWT_REFRESH_VERIFY_SECRETS),
  }));

/**
 * Refresh-token signing and verification (identity only): the signing secret, its key id and TTL,
 * and the verify-only keys.
 */
export const refreshTokenConfig = defineConfigNamespace('refreshToken', refreshTokenEnvSchema);
export type RefreshTokenConfig = ConfigType<typeof refreshTokenConfig>;
