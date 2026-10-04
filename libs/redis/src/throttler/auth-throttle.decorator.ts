import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import { AUTH_THROTTLE_KEY } from './throttle.constants.js';

/**
 * Applies the stricter credential-endpoint limit (`THROTTLE_AUTH_LIMIT` per
 * `THROTTLE_AUTH_TTL_MS`, default 10/min) instead of the default throttler window — use it on
 * login / register / password-reset style handlers (brute-force protection).
 *
 * It only sets metadata: `AppThrottlerGuard` resolves the numbers from the injected
 * `throttleConfig`, so the decorator needs no config at class-definition time and stays DI-pure.
 */
export const AuthThrottle = (): CustomDecorator<string> => SetMetadata(AUTH_THROTTLE_KEY, true);
