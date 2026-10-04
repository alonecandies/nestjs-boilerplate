import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zInt } from '../env/env.helpers.js';

export const cacheEnvSchema = z
  .object({
    CACHE_TTL_MS: zInt(30_000, { min: 1 }),
    CACHE_L1_TTL_MS: zInt(5000, { min: 1 }),
    CACHE_L1_MAX_ITEMS: zInt(5000, { min: 1 }),
  })
  .superRefine((env, ctx) => {
    // An in-process L1 that outlives L2 would keep serving entries other replicas already evicted.
    if (env.CACHE_L1_TTL_MS > env.CACHE_TTL_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['CACHE_L1_TTL_MS'],
        message: 'CACHE_L1_TTL_MS must not exceed CACHE_TTL_MS',
      });
    }
  })
  .transform((env) => ({
    /** L2 (Redis) default TTL, ms. */
    ttlMs: env.CACHE_TTL_MS,
    /** L1 (in-process LRU) TTL, ms — short: it is not invalidated across replicas. */
    l1TtlMs: env.CACHE_L1_TTL_MS,
    l1MaxItems: env.CACHE_L1_MAX_ITEMS,
  }));

/** Two-tier cache (in-memory L1 + Redis L2). */
export const cacheConfig = defineConfigNamespace('cache', cacheEnvSchema);
export type CacheConfig = ConfigType<typeof cacheConfig>;
