import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zInt, zNodeEnv, zStr, zUrl } from '../env/env.helpers.js';
import { parseUrl } from '../env/production-guards.js';

export const redisEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    REDIS_URL: zUrl('redis://localhost:6379', /^rediss?$/),
    REDIS_KEY_PREFIX: zStr('app', {
      pattern: /^[A-Za-z0-9._-]{1,64}$/,
      patternMessage: 'Expected [A-Za-z0-9._-], max 64 chars (":" is added by the key builder)',
    }),
    REDIS_MAX_RETRIES_PER_REQUEST: zInt(3, { min: 0 }),
    REDIS_CONNECT_TIMEOUT_MS: zInt(10_000, { min: 1 }),
    // Production refuses plaintext or password-less Redis unless this explicit opt-out is set.
    REDIS_ALLOW_INSECURE: zBool(false),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production' || env.REDIS_ALLOW_INSECURE) return;
    const url = parseUrl(env.REDIS_URL);
    // Checked the way ioredis reads it: TLS only for a lowercase `rediss://` prefix, and a `tls` query
    // parameter overrides that. The message never echoes the URL: it carries the password.
    if (
      !env.REDIS_URL.startsWith('rediss://') ||
      url === undefined ||
      url.password === '' ||
      url.searchParams.has('tls')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message:
          'REDIS_URL must start with a lowercase rediss:// (TLS) and carry a password or ACL user in production (rediss://user:password@host:6380, no tls= parameter), or set REDIS_ALLOW_INSECURE=true when the network layer secures it',
      });
    }
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
