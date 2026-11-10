import { ConfigModule } from '@nestjs/config';
import { RateLimitModule, type RateLimitPolicy } from '@platform/redis';
import {
  type IdentityRateLimitConfig,
  identityRateLimitConfig,
} from './identity-rate-limit.config.js';

export const IDENTITY_RATE_LIMITS = { CREDENTIALS: 'identity.credentials' } as const;

/** Register and login (REST + GraphQL): per sha256(email)+IP, plus a per-account lockout. */
export function identityRateLimitPolicies(cfg: IdentityRateLimitConfig): RateLimitPolicy[] {
  return [
    {
      name: IDENTITY_RATE_LIMITS.CREDENTIALS,
      key: 'credentials',
      limit: cfg.credentialsLimit,
      ttlMs: cfg.credentialsTtlMs,
      credentialField: 'email',
      lockout: { threshold: cfg.lockoutThreshold, durationMs: cfg.lockoutMs },
    },
  ];
}

export const IdentityRateLimitModule = RateLimitModule.forFeature({
  imports: [ConfigModule.forFeature(identityRateLimitConfig)],
  inject: [identityRateLimitConfig.KEY],
  useFactory: identityRateLimitPolicies,
});
