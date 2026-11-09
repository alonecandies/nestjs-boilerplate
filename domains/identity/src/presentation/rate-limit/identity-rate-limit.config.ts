import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zInt } from '@platform/config';
import { z } from 'zod';

export const identityRateLimitEnvSchema = z
  .object({
    IDENTITY_CREDENTIALS_LIMIT: zInt(10, { min: 1 }),
    IDENTITY_CREDENTIALS_TTL_MS: zInt(60_000, { min: 1 }),
    IDENTITY_LOCKOUT_THRESHOLD: zInt(10, { min: 1 }),
    IDENTITY_LOCKOUT_MS: zInt(900_000, { min: 1 }),
  })
  .transform((env) => ({
    credentialsLimit: env.IDENTITY_CREDENTIALS_LIMIT,
    credentialsTtlMs: env.IDENTITY_CREDENTIALS_TTL_MS,
    lockoutThreshold: env.IDENTITY_LOCKOUT_THRESHOLD,
    lockoutMs: env.IDENTITY_LOCKOUT_MS,
  }));

/** Named rate-limit policies of the identity domain (gateway, monolith). */
export const identityRateLimitConfig = defineConfigNamespace(
  'identityRateLimit',
  identityRateLimitEnvSchema,
);
export type IdentityRateLimitConfig = ConfigType<typeof identityRateLimitConfig>;
