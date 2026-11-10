import { Injectable, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppThrottlerGuard } from './app-throttler.guard.js';
import { THROTTLER } from './throttle.constants.js';

/**
 * The generous pre-authentication flood cap (`THROTTLE_IP_LIMIT` per `THROTTLE_IP_TTL_MS`, keyed by
 * client IP, scope `global`) for HTTP and GraphQL. It must run BEFORE `JwtAuthGuard`, so requests
 * that authentication rejects (401/403 floods) are still counted: see `IpThrottlerModule`.
 */
@Injectable()
export class IpThrottlerGuard extends AppThrottlerGuard {
  protected override readonly enforced: ReadonlySet<string> = new Set<string>([THROTTLER.IP]);
}

/**
 * Registers `IpThrottlerGuard` as a global guard. Global guards run in module-scan order, so
 * import this module BEFORE `AuthModule`; `AppThrottlerModule` (anywhere) provides the options,
 * storage and policy registry.
 */
@Module({
  providers: [IpThrottlerGuard, { provide: APP_GUARD, useExisting: IpThrottlerGuard }],
})
export class IpThrottlerModule {}
