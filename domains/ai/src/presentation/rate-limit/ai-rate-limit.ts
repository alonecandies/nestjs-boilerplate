import { ConfigModule } from '@nestjs/config';
import { RateLimitModule, type RateLimitPolicy } from '@platform/redis';
import { type AiRateLimitConfig, aiRateLimitConfig } from './ai-rate-limit.config.js';

export const AI_RATE_LIMITS = { CHAT: 'ai.chat' } as const;

/**
 * `ai.chat`: each model call (send message) charges the member's bucket and then the tenant's,
 * which every member of the workspace shares, on top of the global budgets.
 */
export function aiRateLimitPolicies(cfg: AiRateLimitConfig): RateLimitPolicy[] {
  return [
    {
      name: AI_RATE_LIMITS.CHAT,
      key: 'user',
      limit: cfg.chatLimit,
      ttlMs: cfg.chatTtlMs,
      tenant: { limit: cfg.chatTenantLimit, ttlMs: cfg.chatTenantTtlMs },
    },
  ];
}

export const AiRateLimitModule = RateLimitModule.forFeature({
  imports: [ConfigModule.forFeature(aiRateLimitConfig)],
  inject: [aiRateLimitConfig.KEY],
  useFactory: aiRateLimitPolicies,
});
