import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { generateId } from '@platform/common';
import { InjectMetric } from '@platform/observability';
import type { Cache } from 'cache-manager';
import type { Redis } from 'ioredis';
import { compact, isArray, isString, uniq } from 'lodash-es';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { InjectRedis, InjectRedisSubscriber } from '../redis.constants.js';
import { BoundedTtlKeyv } from './bounded-ttl-keyv.js';
import {
  APP_CACHE_OPTIONS,
  CACHE_INVALIDATION_CHANNEL,
  type ResolvedAppCacheOptions,
} from './cache.constants.js';
import { openRedisStores } from './redis-store.util.js';

/** `cache_requests_total{cache,outcome}`: cached reads served from the cache (hit) or loaded (miss). */
export const CACHE_REQUESTS_TOTAL = 'cache_requests_total';

/** The slice of a prom-client counter `AppCacheService` needs (tests pass a real `Counter`). */
export interface CacheRequestCounter {
  inc(labels: { cache: string; outcome: 'hit' | 'miss' }): void;
}

/** The label when the caller gave no (safe) name and the key has no safe prefix. */
const OTHER_CACHE = 'other';
const SAFE_CACHE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
/** Most distinct `cache` labels (besides `other`) one process uses; later new names are `other`. */
const MAX_CACHE_LABELS = 32;

/**
 * The `cache` label of one `getOrSet`: the caller's name, else the key's prefix before the first
 * `:`, each only when it is short and made of `[a-z0-9_-]`; anything else (a raw uuid, an id, free
 * text) is `other`. A key never reaches a label. Shape only: `AppCacheService` also caps how
 * many distinct names it labels (`MAX_CACHE_LABELS`), so a caller that derives one from a tenant,
 * user or id cannot create a series per value, but should still never do it.
 */
export function cacheMetricName(key: string, name?: string): string {
  if (name !== undefined && SAFE_CACHE_NAME.test(name)) return name;
  const separator = key.indexOf(':');
  const prefix = separator > 0 ? key.slice(0, separator) : '';
  return SAFE_CACHE_NAME.test(prefix) ? prefix : OTHER_CACHE;
}

interface InvalidationMessage {
  /** Publishing instance (it already dropped its own L1 copy). */
  src: string;
  keys: string[];
}

/**
 * Parses an invalidation broadcast; returns the keys to evict from L1, or `[]` for our own /
 * malformed messages (the channel is shared by every replica — never trust its payload shape).
 */
export function parseInvalidationMessage(raw: string, selfId: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const { src, keys } = parsed as Partial<Record<keyof InvalidationMessage, unknown>>;
  if (src === selfId || !isArray(keys)) return [];
  return keys.filter((key): key is string => isString(key) && key.length > 0);
}

/**
 * Typed facade over the two-tier cache (`CACHE_MANAGER`): read-through `getOrSet` with miss
 * coalescing (concurrent misses of one key run the loader once per process), writes and
 * invalidation. TTLs are milliseconds; L1 copies are capped at `CACHE_L1_TTL_MS`.
 *
 * `set()` / `del()` also broadcast the keys on `${prefix}:cache:invalidate`, so other replicas drop
 * their L1 copy right away instead of serving stale data until it expires.
 */
@Injectable()
export class AppCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppCacheService.name);
  private readonly instanceId = generateId();
  private readonly channel: string;
  private readonly onMessage: (channel: string, message: string) => void;
  private l1: BoundedTtlKeyv | undefined;
  /** The distinct `cache` label values used so far (never `other`), at most `MAX_CACHE_LABELS`. */
  private readonly cacheLabels = new Set<string>();
  private cacheLabelCapWarned = false;

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @InjectRedis() private readonly redis: Redis,
    @InjectRedisSubscriber() private readonly subscriber: Redis,
    keys: RedisKeyService,
    @Inject(APP_CACHE_OPTIONS) private readonly options: ResolvedAppCacheOptions,
    @InjectMetric(CACHE_REQUESTS_TOTAL) private readonly requests: CacheRequestCounter,
  ) {
    this.channel = keys.key(CACHE_INVALIDATION_CHANNEL);
    this.onMessage = (channel, message) => {
      this.handleInvalidation(channel, message);
    };
  }

  onModuleInit(): void {
    // Open the L2 connection now, never lazily on a request (see `openRedisStores`).
    openRedisStores(this.cache);
    if (!this.options.crossInstanceInvalidation) return;
    // AppCacheModule builds `stores: [L1, L2]`; anything else means a custom setup → no-op.
    const l1 = this.cache.stores[0];
    if (!(l1 instanceof BoundedTtlKeyv)) {
      this.logger.warn('L1 store not found — cross-instance L1 invalidation disabled');
      return;
    }
    this.l1 = l1;
    this.subscriber.on('message', this.onMessage);
    // Not awaited: the subscriber connects lazily and must not block boot while Redis starts;
    // ioredis re-subscribes automatically after reconnects.
    this.subscriber.subscribe(this.channel).catch((error: unknown) => {
      this.logger.warn(`cannot subscribe to ${this.channel}: ${errorMessage(error)}`);
    });
  }

  onModuleDestroy(): void {
    // The connection itself is closed by RedisModule (after every module is destroyed).
    this.subscriber.off('message', this.onMessage);
  }

  /**
   * Cached value of `key`, or `loader()` stored for `ttlMs` (default `CACHE_TTL_MS`). Counts
   * `cache_requests_total`: a call that ran the loader is a `miss`, any other (a cache hit, or a
   * concurrent call that waited on another's loader) a `hit`. `cacheName` is the `cache` label; see
   * `cacheMetricName` for the fallback. A process labels at most `MAX_CACHE_LABELS` distinct names:
   * a further one is counted as `other` (and warned about once).
   */
  async getOrSet<T>(
    key: string,
    loader: () => Promise<T>,
    ttlMs?: number,
    cacheName?: string,
  ): Promise<T> {
    const cache = this.cacheLabel(key, cacheName);
    let loaded = false;
    const value = await this.cache.wrap<T>(
      key,
      () => {
        loaded = true;
        this.requests.inc({ cache, outcome: 'miss' });
        return loader();
      },
      ttlMs,
    );
    if (!loaded) this.requests.inc({ cache, outcome: 'hit' });
    return value;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.cache.get<T>(key);
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    await this.cache.set(key, value, ttlMs);
    await this.broadcast([key]);
  }

  /** Evicts `keys` from both tiers (and from every replica's L1). */
  async del(...keys: string[]): Promise<void> {
    const unique = uniq(compact(keys));
    if (unique.length === 0) return;
    await this.cache.mdel(unique);
    await this.broadcast(unique);
  }

  /** `cacheMetricName`, held to `MAX_CACHE_LABELS` distinct names per process. */
  private cacheLabel(key: string, cacheName?: string): string {
    const label = cacheMetricName(key, cacheName);
    if (label === OTHER_CACHE || this.cacheLabels.has(label)) return label;
    if (this.cacheLabels.size < MAX_CACHE_LABELS) {
      this.cacheLabels.add(label);
      return label;
    }
    if (!this.cacheLabelCapWarned) {
      this.cacheLabelCapWarned = true;
      this.logger.warn(
        `more than ${MAX_CACHE_LABELS} distinct cache names: "${label}" and later new names ` +
          `are counted as "${OTHER_CACHE}"; pass a static cache name, never one derived ` +
          'from a tenant or an id',
      );
    }
    return OTHER_CACHE;
  }

  private async broadcast(keys: string[]): Promise<void> {
    if (!this.l1) return;
    const message: InvalidationMessage = { src: this.instanceId, keys };
    try {
      await this.redis.publish(this.channel, JSON.stringify(message));
    } catch (error) {
      // L2 is already updated; other replicas converge when their L1 copy expires.
      this.logger.warn(`L1 invalidation broadcast failed: ${errorMessage(error)}`);
    }
  }

  private handleInvalidation(channel: string, message: string): void {
    if (channel !== this.channel || !this.l1) return;
    const keys = parseInvalidationMessage(message, this.instanceId);
    if (keys.length === 0) return;
    this.l1.deleteMany(keys).catch((error: unknown) => {
      this.logger.warn(`L1 eviction failed: ${errorMessage(error)}`);
    });
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
