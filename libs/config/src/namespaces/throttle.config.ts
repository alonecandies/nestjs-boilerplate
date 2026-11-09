import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zInt } from '../env/env.helpers.js';

export const throttleEnvSchema = z
  .object({
    THROTTLE_TTL_MS: zInt(60_000, { min: 1 }),
    THROTTLE_LIMIT: zInt(300, { min: 1 }),
  })
  .transform((env) => ({
    /** @nestjs/throttler 6 windows are in MILLISECONDS. Per-user (else per-IP) budget across routes. */
    ttlMs: env.THROTTLE_TTL_MS,
    limit: env.THROTTLE_LIMIT,
  }));

/** Rate limiting (Redis-backed @nestjs/throttler). Credential limits are domain policies. */
export const throttleConfig = defineConfigNamespace('throttle', throttleEnvSchema);
export type ThrottleConfig = ConfigType<typeof throttleConfig>;
