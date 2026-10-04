import type { Redis, Result } from 'ioredis';

/**
 * Custom command name. GOTCHA (research data-libs §7.23): redlock `defineCommand`s `acquireLock`,
 * `extendLock` and `releaseLock` on the SAME client — never reuse those names.
 */
export const THROTTLE_COMMAND = 'appThrottleHit';

/**
 * Fixed-window counter + block marker, atomic and in ONE round-trip (EVALSHA via defineCommand,
 * with automatic EVAL fallback on NOSCRIPT). Semantics mirror @nestjs/throttler's in-memory storage:
 * - while blocked, hits are not counted and the remaining block time is reported;
 * - the first hit above `limit` sets the block for `blockDuration` and resets the window, so a
 *   fresh window starts once the block lifts;
 * - `blockDuration <= 0` → no block key; requests are rejected until the window resets.
 *
 * KEYS[1] hits counter, KEYS[2] block marker (same hash slot via a hash tag).
 * ARGV[1] window ms, ARGV[2] limit, ARGV[3] block duration ms.
 * Returns { totalHits, timeToExpireMs, isBlocked (0|1), timeToBlockExpireMs }.
 */
export const THROTTLE_SCRIPT = `
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  return { tonumber(redis.call('GET', KEYS[2])) or 0, blockTtl, 1, blockTtl }
end
local ttl = tonumber(ARGV[1])
local hits = redis.call('INCR', KEYS[1])
local hitsTtl = redis.call('PTTL', KEYS[1])
if hitsTtl < 0 then
  redis.call('PEXPIRE', KEYS[1], ttl)
  hitsTtl = ttl
end
if hits <= tonumber(ARGV[2]) then
  return { hits, hitsTtl, 0, 0 }
end
local block = tonumber(ARGV[3])
if block > 0 then
  redis.call('SET', KEYS[2], hits, 'PX', block)
  redis.call('DEL', KEYS[1])
  return { hits, block, 1, block }
end
return { hits, hitsTtl, 1, hitsTtl }
`;

/** Raw script reply: `[totalHits, timeToExpireMs, isBlocked, timeToBlockExpireMs]`. */
export type ThrottleReply = [number, number, number, number];

declare module 'ioredis' {
  interface RedisCommander<Context> {
    appThrottleHit(
      hitsKey: string,
      blockKey: string,
      ttlMs: number,
      limit: number,
      blockDurationMs: number,
    ): Result<ThrottleReply, Context>;
  }
}

/** Registers the script on `client` (idempotent; cheap — the SHA is computed once per call). */
export function defineThrottleCommand(client: Redis): void {
  client.defineCommand(THROTTLE_COMMAND, { numberOfKeys: 2, lua: THROTTLE_SCRIPT });
}
