import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { RATE_LIMIT_POLICY_KEY, RATE_LIMIT_THROTTLERS } from './throttle.constants.js';

/**
 * Applies a named policy (registered with `RateLimitModule.forFeature`) on top of the global
 * budgets. Every route naming the same policy shares its buckets.
 */
export const RateLimit = (policy: string): CustomDecorator<string> =>
  SetMetadata(RATE_LIMIT_POLICY_KEY, policy);

/**
 * Skips EVERY named throttler (ip, user, route, auth, tenant). Use it instead of `@SkipThrottle()`,
 * whose default only skips a throttler called `default`, which no longer exists.
 */
export const SkipRateLimit = (): MethodDecorator & ClassDecorator =>
  SkipThrottle(Object.fromEntries(RATE_LIMIT_THROTTLERS.map((name) => [name, true])));
