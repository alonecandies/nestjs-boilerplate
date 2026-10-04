import { KeyvCacheableMemory } from 'cacheable';
import { Keyv, type KeyvEntry } from 'keyv';

/**
 * Effective TTL of an L1 write: never longer than `maxTtlMs` and never unbounded (`undefined` / `0`
 * mean "no expiry" in Keyv — an in-process copy must always expire).
 */
export function capTtl(ttl: number | undefined, maxTtlMs: number): number {
  return ttl === undefined || ttl <= 0 ? maxTtlMs : Math.min(ttl, maxTtlMs);
}

/**
 * Keyv whose writes can never outlive `maxTtlMs`.
 *
 * WHY: cache-manager 7 passes the SAME ttl to every tier (`store.set(key, value, ttl ?? opts.ttl)`,
 * and back-fills L1 with the full TTL after an L2 hit), so the `CacheableMemory` default TTL is
 * ignored. L1 is not invalidated across replicas, so it must stay short-lived.
 */
export class BoundedTtlKeyv extends Keyv {
  constructor(
    readonly maxTtlMs: number,
    store: KeyvCacheableMemory,
  ) {
    super({ store, ttl: maxTtlMs, useKeyPrefix: false });
    // In-process tier: keep live objects (CacheableMemory clones on read) instead of JSON round-trips.
    this.serialize = undefined;
    this.deserialize = undefined;
  }

  override async set<Value>(key: string, value: Value, ttl?: number): Promise<boolean> {
    return super.set(key, value, capTtl(ttl, this.maxTtlMs));
  }

  override async setMany(entries: KeyvEntry[]): Promise<boolean[]> {
    return super.setMany(
      entries.map((entry) => ({ ...entry, ttl: capTtl(entry.ttl, this.maxTtlMs) })),
    );
  }
}

export interface L1StoreOptions {
  /** Upper bound for any entry, ms (`CACHE_L1_TTL_MS`). */
  ttlMs: number;
  /** LRU capacity (`CACHE_L1_MAX_ITEMS`) — bounds process memory. */
  maxItems: number;
}

/** In-process LRU tier (L1) with a hard TTL cap. */
export function createL1Store({ ttlMs, maxItems }: L1StoreOptions): BoundedTtlKeyv {
  return new BoundedTtlKeyv(ttlMs, new KeyvCacheableMemory({ ttl: ttlMs, lruSize: maxItems }));
}
