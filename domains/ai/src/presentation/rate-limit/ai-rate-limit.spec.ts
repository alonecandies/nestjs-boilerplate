import { RATE_LIMIT_POLICY_KEY, RateLimitPolicyRegistry } from '@platform/redis';
import { describe, expect, it } from 'vitest';
import { AiController } from '../http/ai.controller.js';
import { aiRateLimitConfig } from './ai-rate-limit.config.js';
import { AI_RATE_LIMITS, aiRateLimitPolicies } from './ai-rate-limit.js';

describe('ai rate-limit policies', () => {
  it('reads AI_CHAT_* with per-user and per-tenant defaults', () => {
    const policies = aiRateLimitPolicies(aiRateLimitConfig.parse({}));
    expect(policies).toEqual([
      {
        name: 'ai.chat',
        key: 'user',
        limit: 20,
        ttlMs: 60_000,
        tenant: { limit: 200, ttlMs: 60_000 },
      },
    ]);
    expect(() => new RateLimitPolicyRegistry().register(policies)).not.toThrow();
    const tuned = aiRateLimitConfig.parse({
      AI_CHAT_LIMIT: '3',
      AI_CHAT_TTL_MS: '1000',
      AI_CHAT_TENANT_LIMIT: '7',
      AI_CHAT_TENANT_TTL_MS: '2000',
    });
    expect(aiRateLimitPolicies(tuned)[0]).toMatchObject({
      limit: 3,
      ttlMs: 1_000,
      tenant: { limit: 7, ttlMs: 2_000 },
    });
  });

  it('sending a message uses the ai.chat policy', () => {
    expect(Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, AiController.prototype.sendMessage)).toBe(
      AI_RATE_LIMITS.CHAT,
    );
  });
});
