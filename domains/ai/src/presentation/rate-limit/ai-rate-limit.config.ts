import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zInt } from '@platform/config';
import { z } from 'zod';

export const aiRateLimitEnvSchema = z
  .object({
    AI_CHAT_LIMIT: zInt(20, { min: 1 }),
    AI_CHAT_TTL_MS: zInt(60_000, { min: 1 }),
    AI_CHAT_TENANT_LIMIT: zInt(200, { min: 1 }),
    AI_CHAT_TENANT_TTL_MS: zInt(60_000, { min: 1 }),
  })
  .transform((env) => ({
    chatLimit: env.AI_CHAT_LIMIT,
    chatTtlMs: env.AI_CHAT_TTL_MS,
    chatTenantLimit: env.AI_CHAT_TENANT_LIMIT,
    chatTenantTtlMs: env.AI_CHAT_TENANT_TTL_MS,
  }));

/** The `ai.chat` policy: model calls per user and per tenant (monolith; gateway with Task 6). */
export const aiRateLimitConfig = defineConfigNamespace('aiRateLimit', aiRateLimitEnvSchema);
export type AiRateLimitConfig = ConfigType<typeof aiRateLimitConfig>;
