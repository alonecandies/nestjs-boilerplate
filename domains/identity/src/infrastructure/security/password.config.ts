import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zInt } from '@platform/config';
import { z } from 'zod';

export const passwordEnvSchema = z
  .object({
    // OWASP 2024 Argon2id baseline: m=19 MiB, t=2, p=1.
    ARGON2_MEMORY_COST: zInt(19_456, { min: 8 }),
    ARGON2_TIME_COST: zInt(2, { min: 1 }),
    ARGON2_PARALLELISM: zInt(1, { min: 1, max: 255 }),
  })
  .transform((env) => ({
    argon2: {
      /** KiB. Hashing runs on the libuv threadpool — size UV_THREADPOOL_SIZE for login bursts. */
      memoryCost: env.ARGON2_MEMORY_COST,
      timeCost: env.ARGON2_TIME_COST,
      parallelism: env.ARGON2_PARALLELISM,
    },
  }));

/** Argon2id cost of identity's `PasswordHasher` (loaded by `IdentityCoreModule` only). */
export const passwordConfig = defineConfigNamespace('password', passwordEnvSchema);
export type PasswordConfig = ConfigType<typeof passwordConfig>;
