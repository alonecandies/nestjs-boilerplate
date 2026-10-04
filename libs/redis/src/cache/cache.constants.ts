/** `AppCacheModuleOptions` (resolved) consumed by `AppCacheService`. */
export const APP_CACHE_OPTIONS = Symbol('APP_CACHE_OPTIONS');

/**
 * L2 key namespace below `REDIS_KEY_PREFIX`: `app:cache:user:42`. Keeps cache keys apart from
 * locks/throttling/denylist so `SCAN app:cache:*` is safe to use for bulk invalidation.
 */
export const CACHE_KEY_NAMESPACE = 'cache';

/** Pub/sub channel (below the prefix) carrying cross-replica L1 invalidations. */
export const CACHE_INVALIDATION_CHANNEL = 'cache:invalidate';

export interface AppCacheModuleOptions {
  /**
   * Broadcast `del()` / `set()` over Redis pub/sub so every replica drops its L1 copy immediately
   * (otherwise other replicas serve the old value for up to `CACHE_L1_TTL_MS`). Default `true`.
   */
  crossInstanceInvalidation?: boolean;
}

export type ResolvedAppCacheOptions = Required<AppCacheModuleOptions>;
