import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zInt, zStr, zUrl } from '../env/env.helpers.js';

export const redisEnvSchema = z
  .object({
    REDIS_URL: zUrl('redis://localhost:6379', /^rediss?$/),
    REDIS_KEY_PREFIX: zStr('app', {
      pattern: /^[A-Za-z0-9._-]{1,64}$/,
      patternMessage: 'Expected [A-Za-z0-9._-], max 64 chars (":" is added by the key builder)',
    }),
    REDIS_MAX_RETRIES_PER_REQUEST: zInt(3, { min: 0 }),
    REDIS_CONNECT_TIMEOUT_MS: zInt(10_000, { min: 1 }),
  })
  .transform((env) => ({
    url: env.REDIS_URL,
    /** Applied by our key builder, NOT as ioredis `keyPrefix` (that breaks BullMQ and redlock). */
    keyPrefix: env.REDIS_KEY_PREFIX,
    maxRetriesPerRequest: env.REDIS_MAX_RETRIES_PER_REQUEST,
    connectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
  }));

/** Redis (ioredis) — cache, locks, throttling, queues, pub/sub. */
export const redisConfig = defineConfigNamespace('redis', redisEnvSchema);
export type RedisConfig = ConfigType<typeof redisConfig>;
