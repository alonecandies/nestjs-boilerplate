import { generateId } from '@app/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
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

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @InjectRedis() private readonly redis: Redis,
    @InjectRedisSubscriber() private readonly subscriber: Redis,
    keys: RedisKeyService,
    @Inject(APP_CACHE_OPTIONS) private readonly options: ResolvedAppCacheOptions,
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

  /** Cached value of `key`, or `loader()` stored for `ttlMs` (default `CACHE_TTL_MS`). */
  async getOrSet<T>(key: string, loader: () => Promise<T>, ttlMs?: number): Promise<T> {
    return this.cache.wrap<T>(key, loader, ttlMs);
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
