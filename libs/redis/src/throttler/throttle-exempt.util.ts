import { getContextType, requestPath } from '@app/common';
import type { ExecutionContext } from '@nestjs/common';

/**
 * `true` when `path` equals an exempt prefix or lives below it on a `/` boundary
 * (`/health` matches `/health` and `/health/ready`, but not `/healthz`).
 */
export function isThrottleExemptPath(path: string, exemptPaths: readonly string[]): boolean {
  return exemptPaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * `skipIf` for the throttler: ops endpoints (probes, scrapers, docs) are never rate limited.
 * Only HTTP carries a URL; every other transport is decided by `AppThrottlerGuard.shouldSkip`.
 */
export function createThrottleSkipIf(
  exemptPaths: readonly string[],
): (context: ExecutionContext) => boolean {
  if (exemptPaths.length === 0) return () => false;
  return (context: ExecutionContext): boolean => {
    if (getContextType(context) !== 'http') return false;
    const req = context.switchToHttp().getRequest<{ url?: string; originalUrl?: string }>();
    return isThrottleExemptPath(requestPath(req), exemptPaths);
  };
}
