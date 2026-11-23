# @platform/redis

The ioredis 6 infrastructure every service shares:

- global clients (`RedisModule`) and a namespaced key builder
- distributed locks, with `@WithLock` for crons
- a two-tier cache: in-process L1 plus Redis L2
- Redis-backed rate limiting
- the BullMQ connection
- the socket.io Redis adapter
- the readiness contributor

## Public API

| Export                                                                                                                           | Kind                | Purpose                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RedisModule.forRootAsync(opts?: RedisModuleOptions)`                                                                            | global module       | `REDIS_CLIENT` (auto-pipelined), `REDIS_SUBSCRIBER` (lazy `duplicate()`), `REDLOCK`, `RedisKeyService`, `DistributedLockService`, `RedisHealthIndicator`. Waits for `ready` at boot; `QUIT`s both connections in `onApplicationShutdown`. Options: `connectionName`, `clientOptions`, `waitForReady` (default `true`).     |
| `REDIS_CLIENT`, `REDIS_SUBSCRIBER`, `InjectRedis()`, `InjectRedisSubscriber()`                                                   | tokens / decorators | Inject with `@InjectRedis() private readonly redis: Redis` (`import type { Redis } from 'ioredis'`).                                                                                                                                                                                                                       |
| `createRedisClient(cfg, overrides?)`                                                                                             | factory             | Throughput defaults: auto-pipelining, bounded `maxRetriesPerRequest`, capped jittered reconnect, READONLY failover, keep-alive and a throttled error logger. **No `keyPrefix`.**                                                                                                                                           |
| `waitForRedisReady`, `closeRedisClient`, `redactRedisUrl`, `redisRetryStrategy`, `reconnectOnReadonly`, `attachRedisErrorLogger` | helpers             | Lifecycle and logging building blocks.                                                                                                                                                                                                                                                                                     |
| `RedisKeyService.key(...parts)`, `joinKey(prefix, ...parts)`, `hashTag(v)`                                                       | keys                | `${REDIS_KEY_PREFIX}:a:b`. Empty segments are rejected. `{…}` is a Cluster hash tag.                                                                                                                                                                                                                                       |
| `DistributedLockService.using(resource, ttlMs, fn)`                                                                              | service             | Runs `fn(signal)` on ONE replica. Returns `{ acquired: true, result }` or `{ acquired: false, reason: 'held' \| 'error' }`.                                                                                                                                                                                                |
| `@WithLock(resource, ttlMs)`                                                                                                     | method decorator    | Wraps a `@Cron()` method. Non-winning replicas skip it and it resolves `undefined`.                                                                                                                                                                                                                                        |
| `AppCacheModule.forRootAsync({ crossInstanceInvalidation? })`                                                                    | global module       | `CACHE_MANAGER` (cache-manager 7) with stores `[L1, L2]` and `AppCacheService`.                                                                                                                                                                                                                                            |
| `AppCacheService`                                                                                                                | service             | `getOrSet(key, loader, ttlMs?)` (read-through, coalesces misses), `get`, `set`, `del(...keys)`.                                                                                                                                                                                                                            |
| `tenantCacheKey(scope, tenantId, ...parts)`                                                                                      | function            | `<scope>:<tenantId>:<part>…`, the one builder of cache keys for tenant-scoped data. `scope` matches `/^[a-z][a-z0-9-]*$/`; `tenantId` is a UUID (lower-cased), never the platform tenant, and comes from the principal or a validated event envelope; at least one part, none empty or containing `:`. Throws `TypeError`. |
| `openRedisStores(cache)`                                                                                                         | function            | `(cache: Pick<Cache, 'stores'>) => number` — opens every `@keyv/redis` tier once, eagerly (called by `AppCacheService.onModuleInit`; use it for custom `CacheModule` setups).                                                                                                                                              |
| `BoundedTtlKeyv`, `capTtl`, `createL1Store`, `createCacheOptions`                                                                | cache internals     | For custom cache setups.                                                                                                                                                                                                                                                                                                   |
| `AppThrottlerModule.forRootAsync({ exemptPaths?, ignoreUserAgents?, failOpen?, globalGuard? })`                                  | module              | `@nestjs/throttler` with `RedisThrottlerStorage` and `APP_GUARD` `AppThrottlerGuard`.                                                                                                                                                                                                                                      |
| `AppThrottlerGuard`                                                                                                              | guard               | Throttles http/graphql and skips ws/rpc. Tracker is `user:<id>` or `ip:<normalised ip>`.                                                                                                                                                                                                                                   |
| `WsThrottlerGuard`                                                                                                               | guard               | Per-message throttling for gateways (`@UseGuards(WsThrottlerGuard)`). Tracker is `socket.data.user.id` or the handshake address; a block raises 429 through the WS filter.                                                                                                                                                 |
| `throttleTracker(user, ip, ipv6Prefix)`                                                                                          | helper              | The shared tracker rule.                                                                                                                                                                                                                                                                                                   |
| `RateLimit(policy)`                                                                                                              | decorator           | Route policy, looked up in `RateLimitPolicyRegistry` (limits come from the domain's env).                                                                                                                                                                                                                                  |
| `SkipRateLimit()`                                                                                                                | decorator           | Skips every throttler, including those added later.                                                                                                                                                                                                                                                                        |
| `RateLimitModule.forFeature({ useFactory })`                                                                                     | module              | Domains register their policies. A `user` policy may add `tenant: { limit, ttlMs }`: a second bucket per active tenant, shared by its members and charged after the member's own (header item `"tenant:<policy>"`).                                                                                                        |
| `IpThrottlerModule`                                                                                                              | module              | Pre-auth `ip` guard: import it BEFORE `AuthModule`.                                                                                                                                                                                                                                                                        |
| `RateLimitPolicyRegistry`                                                                                                        | service             | `register`, `get`, `require`, `names`; unknown policy names fail at boot.                                                                                                                                                                                                                                                  |
| `SkipThrottle`                                                                                                                   | re-export           | From `@nestjs/throttler`; prefer `SkipRateLimit`/`RateLimit`, which know every throttler name. `Throttle` is not re-exported: a `@Throttle()` override (also from a direct import) fails boot.                                                                                                                             |
| `RateLimitCharger`                                                                                                               | service             | `charge(bucket, weight?)`: one weighted charge outside the guards (GraphQL cost, graphql-ws, handshakes); returns the record and the `RateLimitDecision`. `trackerFor(principal, ip)` builds `user:`/`ip:` trackers.                                                                                                       |
| `ConnectionCaps`, `TOO_MANY_CONNECTIONS`                                                                                         | service             | `admitHandshake(ip)` (per-IP `ws-handshake` budget), `acquireSocket(userId, tokenExp)` → `SocketSlot` `{ admitted, id }` / `releaseSocket(userId, id)` (per-user sockets: one Lua sorted-set slot each, kept until max(TTL, token expiry + 60 s); release every admitted slot by id). Both fail open without Redis.        |
| `RedisThrottlerStorage`, `THROTTLE_SCRIPT`, `THROTTLE_COMMAND`                                                                   | storage             | One `EVALSHA` per request: fixed window plus a block key.                                                                                                                                                                                                                                                                  |
| `AppQueueModule.forRootAsync({ prefix?, defaultJobOptions? })`, `createQueueOptions`, `DEFAULT_JOB_OPTIONS`                      | module              | BullMQ 6 root config: `maxRetriesPerRequest: null`, prefix `bull`, 5 attempts with exponential backoff, bounded retention.                                                                                                                                                                                                 |
| `RedisIoAdapter`, `createRedisIoAdapter(app, opts?)`, `DEFAULT_IO_SERVER_OPTIONS`                                                | socket.io           | Fans broadcasts out through Redis pub/sub. Websocket-only transport by default.                                                                                                                                                                                                                                            |
| `RedisHealthIndicator`                                                                                                           | `HealthContributor` | Key `redis`. PING with a 1 s timeout, result cached 1 s; `down` without PING while reconnecting.                                                                                                                                                                                                                           |
| `@platform/redis/testing` → `InMemoryRedis`                                                                                      | test double         | Strings with TTL, counters, pub/sub between `duplicate()`s, and the throttle script emulated in JS.                                                                                                                                                                                                                        |

### Throttlers

| Throttler      | Key                   | Scope                           |
| -------------- | --------------------- | ------------------------------- |
| `ip`           | client IP             | `global`                        |
| `user`         | user id, else IP      | `global`                        |
| `route`        | user or IP per policy | policy name                     |
| `auth`         | sha256(email)+IP      | policy name                     |
| `lockout`      | sha256(email)         | policy name, never advertised   |
| `tenant`       | active tenant id      | `global`                        |
| `graphql`      | user id, else IP      | `cost` (weighted per operation) |
| `ws-handshake` | client IP             | `global`                        |

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
@WithLock('orders:purge-expired', 60_000)
async purge(): Promise<void> { … }

// read-through cache
return this.cache.getOrSet(`user:${id}`, () => this.users.getUser(id), 30_000);
```

## Environment

These variables come from the `redis`, `cache` and `throttle` namespaces of `@platform/config`:

- `REDIS_URL`: default `redis://localhost:6379`; use `rediss://` for TLS.
- `REDIS_KEY_PREFIX`: default `app`.
- `REDIS_MAX_RETRIES_PER_REQUEST`: default 3.
- `REDIS_CONNECT_TIMEOUT_MS`: default 10000.
- `CACHE_TTL_MS`: default 30000.
- `CACHE_L1_TTL_MS`: default 5000.
- `CACHE_L1_MAX_ITEMS`: default 5000.
- `THROTTLE_TTL_MS` and `THROTTLE_LIMIT`: default 60000 and 300.
- `THROTTLE_IP_TTL_MS` and `THROTTLE_IP_LIMIT`: default 60000 and 600.
- `THROTTLE_REDIS_TIMEOUT_MS`: default 250. Also bounds `ConnectionCaps` slot commands: an acquire that times out fails open, a release that times out logs a throttled warning.
- `THROTTLE_TENANT_TTL_MS` and `THROTTLE_TENANT_LIMIT`: default 60000 and 3000.
- `THROTTLE_GRAPHQL_TTL_MS` and `THROTTLE_GRAPHQL_COST_LIMIT`: default 60000 and 20000.
- `THROTTLE_WS_HANDSHAKE_LIMIT` and `THROTTLE_WS_HANDSHAKE_TTL_MS`: default 30 and 60000.
- `THROTTLE_WS_SOCKETS_PER_USER` and `THROTTLE_WS_SOCKET_TTL_MS`: default 10 and 3600000.

`SERVICE_NAME` from app config is used as the connection name when it is available.

## Server requirements

The Redis behind `REDIS_URL` must run with `maxmemory-policy noeviction` and AOF (`appendonly yes`): the access-token
denylist, BullMQ queues, locks and throttle counters share it, and any eviction drops one of them silently. At boot
`RedisModule` reads `maxmemory_policy` from `INFO memory` (`checkRedisEvictionPolicy`): a policy other than
`noeviction` logs one error line (`event: redis_eviction_policy_unsafe`) and sets the gauge
`redis_eviction_policy_safe` to `0` (`1` when safe; absent when `INFO` fails or hides the value). The check never fails
the boot. Sizing and the alert: [SECURITY.md](../../docs/SECURITY.md#production-checklist).

## Key layout

- `{prefix}:auth:denylist:{jti}`
- `{prefix}:lock:{resource}`
- `{prefix}:throttle:{name:sha256}:hits|block`
- `{prefix}:wsslot:{userId}` (a sorted set of the user's socket slots; only `ConnectionCaps` writes it)
- `{prefix}:cache:{key}`; tenant-scoped data `{prefix}:cache:{scope}:{tenantId}:{part}…` (build `{key}` with
  `tenantCacheKey`, never by hand: a tenant-scoped value under a key without the tenant can be served to another
  tenant)
- pub/sub channels `{prefix}:cache:invalidate` and `{prefix}:socket.io#…`
- BullMQ `bull:{queue}:…`

## Gotchas

- **Never set ioredis `keyPrefix`.** BullMQ rejects prefixed connections, and Lua scripts and redlock would see double-prefixed keys. Build keys with `RedisKeyService`.
- **Redlock command names.** `@sesamecare-oss/redlock` defines `acquireLock`, `extendLock` and `releaseLock` on the shared client. Our script is named `appThrottleHit`; never reuse the redlock names. Never call `redlock.quit()`, because it QUITs the shared client.
- **Guard order.** Global guards run in module-registration order. Import `AuthModule` before `AppThrottlerModule`, otherwise every request is tracked per IP. Alternatively, pass `globalGuard: false` and register the throttler guard yourself.
- **WebSockets are not throttled** by the global guard. Put `@UseGuards(WsThrottlerGuard)` on gateways (never as `APP_GUARD`).
- **Redis down.** Budgets (`ip`, `user`, `route`) fail open within `THROTTLE_REDIS_TIMEOUT_MS` and count `rate_limit_fail_open_total`; `auth` and `lockout` fail closed with 503. Pass `failOpen` to `AppThrottlerModule.forRootAsync` to change that per throttler. The auth denylist (in `@platform/auth`) fails closed.
- **Cache.** `nonBlocking` is deliberately off: in cache-manager 7 it lets an L1 miss win over an L2 hit. L1 TTLs are capped at `CACHE_L1_TTL_MS`, because cache-manager passes the L2 TTL to every tier. `get()` does not back-fill L1; `getOrSet()` does. `set()` and `del()` broadcast invalidations so other replicas drop their L1 copy.
- **L2 connection pool.** `@keyv/redis` uses node-redis, not ioredis, so it opens a second connection pool.
- **L2 outage = cache miss, not a stall.** Left to itself, `@keyv/redis` connects lazily on the first cache call, races that against `connectionTimeout` (`REDIS_CONNECT_TIMEOUT_MS`, 10 s) and destroys the client on failure — so with Redis down _every_ `getOrSet` waited ~10 s on get and again on set (and leaked listeners). The L2 client is therefore built with `disableOfflineQueue` + a never-giving-up reconnect strategy and opened eagerly by `AppCacheService` (`openRedisStores`): while Redis is down, L2 commands fail at once, reads fall through to L1 + loader, and the tier recovers by itself (`redis-store.util.spec.ts`).
- **BullMQ 6.** Custom `jobId`s must not contain `:`. Use `queue.upsertJobScheduler` instead of the removed `repeat` option.
- **socket.io.** `connectionStateRecovery` is not supported by the Redis adapter. Both adapter connections are closed in `dispose()`.
- **Integration tests.** `INTEGRATION=1 bunx vitest run --project redis:int` runs `src/redis.int-spec.ts` against a real Redis (the Lua script vs its JS model, redlock contention and auto-extension, L2 plus pub/sub invalidation, and the socket.io adapter).
