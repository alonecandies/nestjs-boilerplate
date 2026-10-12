import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zInt, zNodeEnv, zStr } from '../env/env.helpers.js';
import { addKnownLocalSecretIssue, isKnownLocalSecret } from '../env/production-guards.js';

/** Development-only defaults so `bun run dev` works with zero `.env`. Rejected in production. */
export const DEV_JWT_ACCESS_SECRET = 'dev-access-secret-change-me-please-32chars';
export const DEV_JWT_REFRESH_SECRET = 'dev-refresh-secret-change-me-please-32chars';

/** Every HS256 JWT secret (access and refresh) is at least this long, in every environment. */
export const MIN_JWT_SECRET_LENGTH = 32;

export const authEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    JWT_ACCESS_SECRET: zStr(DEV_JWT_ACCESS_SECRET, { min: MIN_JWT_SECRET_LENGTH }),
    JWT_ACCESS_TTL_SEC: zInt(900, { min: 1 }),
    JWT_REFRESH_SECRET: zStr(DEV_JWT_REFRESH_SECRET, { min: MIN_JWT_SECRET_LENGTH }),
    JWT_REFRESH_TTL_SEC: zInt(604_800, { min: 1 }),
    JWT_ISSUER: zStr('nestjs-boilerplate'),
    JWT_AUDIENCE: zStr('nestjs-boilerplate'),
    AUTH_DENYLIST_ENABLED: zBool(true),
    // LOCAL compose stack only: accept the publicly known compose fallbacks in production mode.
    ALLOW_KNOWN_LOCAL_SECRETS: zBool(false),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    const devDefaults = {
      JWT_ACCESS_SECRET: DEV_JWT_ACCESS_SECRET,
      JWT_REFRESH_SECRET: DEV_JWT_REFRESH_SECRET,
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
    accessSecret: env.JWT_ACCESS_SECRET,
    accessTtlSec: env.JWT_ACCESS_TTL_SEC,
    refreshSecret: env.JWT_REFRESH_SECRET,
    refreshTtlSec: env.JWT_REFRESH_TTL_SEC,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    denylistEnabled: env.AUTH_DENYLIST_ENABLED,
  }));

/** JWT signing/verification, token TTLs, access-token denylist. */
export const authConfig = defineConfigNamespace('auth', authEnvSchema);
export type AuthConfig = ConfigType<typeof authConfig>;
