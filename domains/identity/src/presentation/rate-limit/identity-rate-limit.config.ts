import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zInt } from '@platform/config';
import { z } from 'zod';

/**
 * Variables removed without an alias, with what replaces them. Setting one fails validation instead
 * of being ignored, so a deployment that still sets it learns the new name at boot. Blank = unset.
 */
const REMOVED_VARS: Readonly<Record<string, string>> = {
  THROTTLE_AUTH_LIMIT: 'IDENTITY_CREDENTIALS_LIMIT',
  THROTTLE_AUTH_TTL_MS: 'IDENTITY_CREDENTIALS_TTL_MS',
};

export const identityRateLimitEnvSchema = z
  .object({
    IDENTITY_CREDENTIALS_LIMIT: zInt(10, { min: 1 }),
    IDENTITY_CREDENTIALS_TTL_MS: zInt(60_000, { min: 1 }),
    IDENTITY_LOCKOUT_THRESHOLD: zInt(10, { min: 1 }),
    IDENTITY_LOCKOUT_MS: zInt(900_000, { min: 1 }),
  })
  // Keeps the undeclared keys so the check below can see the removed variables.
  .loose()
  .superRefine((env, ctx) => {
    for (const [removed, replacement] of Object.entries(REMOVED_VARS)) {
      const value = env[removed];
      if (typeof value !== 'string' || value.trim() === '') continue;
      ctx.addIssue({
        code: 'custom',
        path: [removed],
        message: `${removed} was removed: set ${replacement} instead`,
      });
    }
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
