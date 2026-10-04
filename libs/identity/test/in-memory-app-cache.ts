import type { AppCacheService } from '@app/redis';

/**
 * Stand-in for `AppCacheService` (no Redis): a Map with the same read-through semantics, and a
 * JSON round trip like the Redis L2 tier (Dates come back as ISO strings).
 */
export class InMemoryAppCache implements Pick<AppCacheService, 'getOrSet' | 'get' | 'set' | 'del'> {
  readonly store = new Map<string, string>();
  readonly loads: string[] = [];

  async getOrSet<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.store.get(key);
    if (hit !== undefined) return JSON.parse(hit) as T;
    this.loads.push(key);
    const value = await loader();
    this.store.set(key, JSON.stringify(value));
    return value;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const hit = this.store.get(key);
    return hit === undefined ? undefined : (JSON.parse(hit) as T);
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
  }
}
