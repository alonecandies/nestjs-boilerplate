import type { LockResult } from './lock.types.js';

/** What `@WithLock` needs from `DistributedLockService` (kept structural to avoid an import cycle). */
export interface LockRunner {
  using<T>(
    resource: string,
    ttlMs: number,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<LockResult<T>>;
}

/**
 * Module-scoped holder for the process' lock service. This is the one documented exception to pure
 * DI (blueprint §3.8): method decorators run at class-definition time, long before the container
 * exists, so `@WithLock` resolves the service lazily through this holder. It is set by
 * `DistributedLockService.onModuleInit`; the most recently initialised app wins (tests).
 */
let currentRunner: LockRunner | undefined;

/** `undefined` unregisters (tests). */
export function registerLockRunner(runner: LockRunner | undefined): void {
  currentRunner = runner;
}

export function getLockRunner(): LockRunner | undefined {
  return currentRunner;
}
