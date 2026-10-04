import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zInt } from '../env/env.helpers.js';

export const throttleEnvSchema = z
  .object({
    THROTTLE_TTL_MS: zInt(60_000, { min: 1 }),
    THROTTLE_LIMIT: zInt(100, { min: 1 }),
    THROTTLE_AUTH_TTL_MS: zInt(60_000, { min: 1 }),
    THROTTLE_AUTH_LIMIT: zInt(10, { min: 1 }),
  })
  .transform((env) => ({
    /** @nestjs/throttler 6 windows are in MILLISECONDS. */
    ttlMs: env.THROTTLE_TTL_MS,
    limit: env.THROTTLE_LIMIT,
    /** Stricter window for credential endpoints (login/register) — brute-force protection. */
    authTtlMs: env.THROTTLE_AUTH_TTL_MS,
    authLimit: env.THROTTLE_AUTH_LIMIT,
  }));

/** Rate limiting (Redis-backed @nestjs/throttler). */
export const throttleConfig = defineConfigNamespace('throttle', throttleEnvSchema);
export type ThrottleConfig = ConfigType<typeof throttleConfig>;
