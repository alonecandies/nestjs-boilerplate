# @app/redis

The ioredis 6 infrastructure every service shares:

- global clients (`RedisModule`) and a namespaced key builder
- distributed locks, with `@WithLock` for crons
- a two-tier cache: in-process L1 plus Redis L2
- Redis-backed rate limiting
- the BullMQ connection
- the socket.io Redis adapter
- the readiness contributor

## Public API

| Export                                                                                                                           | Kind                | Purpose                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RedisModule.forRootAsync(opts?: RedisModuleOptions)`                                                                            | global module       | `REDIS_CLIENT` (auto-pipelined), `REDIS_SUBSCRIBER` (lazy `duplicate()`), `REDLOCK`, `RedisKeyService`, `DistributedLockService`, `RedisHealthIndicator`. Waits for `ready` at boot; `QUIT`s both connections in `onApplicationShutdown`. Options: `connectionName`, `clientOptions`, `waitForReady` (default `true`). |
| `REDIS_CLIENT`, `REDIS_SUBSCRIBER`, `InjectRedis()`, `InjectRedisSubscriber()`                                                   | tokens / decorators | Inject with `@InjectRedis() private readonly redis: Redis` (`import type { Redis } from 'ioredis'`).                                                                                                                                                                                                                   |
| `createRedisClient(cfg, overrides?)`                                                                                             | factory             | Throughput defaults: auto-pipelining, bounded `maxRetriesPerRequest`, capped jittered reconnect, READONLY failover, keep-alive and a throttled error logger. **No `keyPrefix`.**                                                                                                                                       |
| `waitForRedisReady`, `closeRedisClient`, `redactRedisUrl`, `redisRetryStrategy`, `reconnectOnReadonly`, `attachRedisErrorLogger` | helpers             | Lifecycle and logging building blocks.                                                                                                                                                                                                                                                                                 |
| `RedisKeyService.key(...parts)`, `joinKey(prefix, ...parts)`, `hashTag(v)`                                                       | keys                | `${REDIS_KEY_PREFIX}:a:b`. Empty segments are rejected. `{…}` is a Cluster hash tag.                                                                                                                                                                                                                                   |
| `DistributedLockService.using(resource, ttlMs, fn)`                                                                              | service             | Runs `fn(signal)` on ONE replica. Returns `{ acquired: true, result }` or `{ acquired: false, reason: 'held' \| 'error' }`.                                                                                                                                                                                            |
| `@WithLock(resource, ttlMs)`                                                                                                     | method decorator    | Wraps a `@Cron()` method. Non-winning replicas skip it and it resolves `undefined`.                                                                                                                                                                                                                                    |
| `AppCacheModule.forRootAsync({ crossInstanceInvalidation? })`                                                                    | global module       | `CACHE_MANAGER` (cache-manager 7) with stores `[L1, L2]` and `AppCacheService`.                                                                                                                                                                                                                                        |
| `AppCacheService`                                                                                                                | service             | `getOrSet(key, loader, ttlMs?)` (read-through, coalesces misses), `get`, `set`, `del(...keys)`.                                                                                                                                                                                                                        |
| `openRedisStores(cache)`                                                                                                         | function            | `(cache: Pick<Cache, 'stores'>) => number` — opens every `@keyv/redis` tier once, eagerly (called by `AppCacheService.onModuleInit`; use it for custom `CacheModule` setups).                                                                                                                                          |
| `BoundedTtlKeyv`, `capTtl`, `createL1Store`, `createCacheOptions`                                                                | cache internals     | For custom cache setups.                                                                                                                                                                                                                                                                                               |
| `AppThrottlerModule.forRootAsync({ exemptPaths?, ignoreUserAgents?, failOpen?, globalGuard? })`                                  | module              | `@nestjs/throttler` with `RedisThrottlerStorage` and `APP_GUARD` `AppThrottlerGuard`.                                                                                                                                                                                                                                  |
| `AppThrottlerGuard`                                                                                                              | guard               | Throttles http/graphql and skips ws/rpc. Tracker is `user:<id>` or `ip:<normalised ip>`.                                                                                                                                                                                                                               |
| `WsThrottlerGuard`                                                                                                               | guard               | Per-message throttling for gateways (`@UseGuards(WsThrottlerGuard)`). Tracker is `socket.data.user.id` or the handshake address; a block raises 429 through the WS filter.                                                                                                                                             |
| `throttleTracker(user, ip, ipv6Prefix)`                                                                                          | helper              | The shared tracker rule.                                                                                                                                                                                                                                                                                               |
| `AuthThrottle()`                                                                                                                 | decorator           | Uses the `THROTTLE_AUTH_LIMIT` / `THROTTLE_AUTH_TTL_MS` window (login, register).                                                                                                                                                                                                                                      |
| `SkipThrottle`, `Throttle`                                                                                                       | re-exports          | From `@nestjs/throttler`, so feature libs don't need the dependency.                                                                                                                                                                                                                                                   |
| `RedisThrottlerStorage`, `THROTTLE_SCRIPT`, `THROTTLE_COMMAND`                                                                   | storage             | One `EVALSHA` per request: fixed window plus a block key.                                                                                                                                                                                                                                                              |
| `AppQueueModule.forRootAsync({ prefix?, defaultJobOptions? })`, `createQueueOptions`, `DEFAULT_JOB_OPTIONS`                      | module              | BullMQ 6 root config: `maxRetriesPerRequest: null`, prefix `bull`, 5 attempts with exponential backoff, bounded retention.                                                                                                                                                                                             |
| `RedisIoAdapter`, `createRedisIoAdapter(app, opts?)`, `DEFAULT_IO_SERVER_OPTIONS`                                                | socket.io           | Fans broadcasts out through Redis pub/sub. Websocket-only transport by default.                                                                                                                                                                                                                                        |
| `RedisHealthIndicator`                                                                                                           | `HealthContributor` | Key `redis`. PING with a 1 s timeout, result cached 1 s; `down` without PING while reconnecting.                                                                                                                                                                                                                       |
| `@app/redis/testing` → `InMemoryRedis`                                                                                           | test double         | Strings with TTL, counters, pub/sub between `duplicate()`s, and the throttle script emulated in JS.                                                                                                                                                                                                                    |

## Usage

```ts
@Module({
  imports: [
    AppConfigModule.forRoot(),
    RedisModule.forRootAsync(),
    AuthModule.forRootAsync(),        // BEFORE the throttler → per-user rate limits
    AppThrottlerModule.forRootAsync(),
    AppCacheModule.forRootAsync(),
    AppQueueModule.forRootAsync(),
    ObservabilityModule.forRoot({ healthContributors: [RedisHealthIndicator] }),
  ],
})
export class AppModule {}

// main.ts
app.useWebSocketAdapter(await createRedisIoAdapter(app));

// cron that must run on one replica only
@Cron(CronExpression.EVERY_HOUR, { waitForCompletion: true })
@WithLock('identity:purge-sessions', 60_000)
async purge(): Promise<void> { … }

// read-through cache
return this.cache.getOrSet(`user:${id}`, () => this.users.getUser(id), 30_000);
```

## Environment

These variables come from the `redis`, `cache` and `throttle` namespaces of `@app/config`:

- `REDIS_URL`: default `redis://localhost:6379`; use `rediss://` for TLS.
- `REDIS_KEY_PREFIX`: default `app`.
- `REDIS_MAX_RETRIES_PER_REQUEST`: default 3.
- `REDIS_CONNECT_TIMEOUT_MS`: default 10000.
- `CACHE_TTL_MS`: default 30000.
- `CACHE_L1_TTL_MS`: default 5000.
- `CACHE_L1_MAX_ITEMS`: default 5000.
- `THROTTLE_TTL_MS` and `THROTTLE_LIMIT`: default 60000 and 100.
- `THROTTLE_AUTH_TTL_MS` and `THROTTLE_AUTH_LIMIT`: default 60000 and 10.

`SERVICE_NAME` from app config is used as the connection name when it is available.

## Key layout

- `{prefix}:auth:denylist:{jti}`
- `{prefix}:lock:{resource}`
- `{prefix}:throttle:{name:sha256}:hits|block`
- `{prefix}:cache:{key}`
- pub/sub channels `{prefix}:cache:invalidate` and `{prefix}:socket.io#…`
- BullMQ `bull:{queue}:…`

## Gotchas

- **Never set ioredis `keyPrefix`.** BullMQ rejects prefixed connections, and Lua scripts and redlock would see double-prefixed keys. Build keys with `RedisKeyService`.
- **Redlock command names.** `@sesamecare-oss/redlock` defines `acquireLock`, `extendLock` and `releaseLock` on the shared client. Our script is named `appThrottleHit`; never reuse the redlock names. Never call `redlock.quit()`, because it QUITs the shared client.
- **Guard order.** Global guards run in module-registration order. Import `AuthModule` before `AppThrottlerModule`, otherwise every request is tracked per IP. Alternatively, pass `globalGuard: false` and register the throttler guard yourself.
- **WebSockets are not throttled** by the global guard. Put `@UseGuards(WsThrottlerGuard)` on gateways (never as `APP_GUARD`).
- **Throttler fails open by default.** When Redis is not `ready`, requests pass and a warning is logged every 10 s. Set `failOpen: false` to reject with 503 instead. The auth denylist (in `@app/auth`) fails closed.
- **Cache.** `nonBlocking` is deliberately off: in cache-manager 7 it lets an L1 miss win over an L2 hit. L1 TTLs are capped at `CACHE_L1_TTL_MS`, because cache-manager passes the L2 TTL to every tier. `get()` does not back-fill L1; `getOrSet()` does. `set()` and `del()` broadcast invalidations so other replicas drop their L1 copy.
- **L2 connection pool.** `@keyv/redis` uses node-redis, not ioredis, so it opens a second connection pool.
- **L2 outage = cache miss, not a stall.** Left to itself, `@keyv/redis` connects lazily on the first cache call, races that against `connectionTimeout` (`REDIS_CONNECT_TIMEOUT_MS`, 10 s) and destroys the client on failure — so with Redis down _every_ `getOrSet` waited ~10 s on get and again on set (and leaked listeners). The L2 client is therefore built with `disableOfflineQueue` + a never-giving-up reconnect strategy and opened eagerly by `AppCacheService` (`openRedisStores`): while Redis is down, L2 commands fail at once, reads fall through to L1 + loader, and the tier recovers by itself (`redis-store.util.spec.ts`).
- **BullMQ 6.** Custom `jobId`s must not contain `:`. Use `queue.upsertJobScheduler` instead of the removed `repeat` option.
- **socket.io.** `connectionStateRecovery` is not supported by the Redis adapter. Both adapter connections are closed in `dispose()`.
- **Integration tests.** `INTEGRATION=1 bunx vitest run --project redis:int` runs `src/redis.int-spec.ts` against a real Redis (the Lua script vs its JS model, redlock contention and auto-extension, L2 plus pub/sub invalidation, and the socket.io adapter).
