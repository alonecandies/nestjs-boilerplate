import type { ConfigType } from '@nestjs/config';
import {
  addKnownLocalSecretIssue,
  DEV_JWT_ACCESS_SECRET,
  defineConfigNamespace,
  isKnownLocalSecret,
  MIN_JWT_SECRET_LENGTH,
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
    JWT_REFRESH_TTL_SEC: zInt(604_800, { min: 1 }),
    // Read only for the must-differ guard below (same default as `auth`, so the comparison sees
    // the value the access verifier uses); the `auth` namespace validates it.
    JWT_ACCESS_SECRET: zStr(DEV_JWT_ACCESS_SECRET),
    // LOCAL compose stack only: accept the publicly known compose fallbacks in production mode.
    ALLOW_KNOWN_LOCAL_SECRETS: zBool(false),
  })
  .superRefine((env, ctx) => {
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
    // A shared secret would let a refresh token verify as an access token (and vice versa).
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET in production',
      });
    }
  })
  .transform((env) => ({
    refreshSecret: env.JWT_REFRESH_SECRET,
    refreshTtlSec: env.JWT_REFRESH_TTL_SEC,
  }));

/** Refresh-token signing and verification (identity only): secret and TTL. */
export const refreshTokenConfig = defineConfigNamespace('refreshToken', refreshTokenEnvSchema);
export type RefreshTokenConfig = ConfigType<typeof refreshTokenConfig>;
