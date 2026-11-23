import type { Result } from 'ioredis';

/** Takes one per-socket connection slot (`ConnectionCaps.acquireSocket`). */
export const CONN_COUNT_COMMAND = 'appConnSlot';

/**
 * KEYS[1] the user's slots: a sorted set of slot ids scored by their deadline (epoch ms).
 * ARGV[1] slot id, ARGV[2] cap, ARGV[3] slot ttl ms, ARGV[4] token deadline (epoch ms).
 * Returns 1 (admitted) or 0 (refused).
 * - Times come from the Redis clock (`TIME`): slots whose deadline has passed are dropped first.
 * - A slot id that is already a member is admitted again unchanged, so a resent acquire is
 *   idempotent.
 * - Otherwise the slot is refused at the cap, or added with the deadline
 *   max(now + ttl, token deadline).
 * - The key expires with its latest deadline, so it never expires before any slot it holds.
 * Release is a plain `ZREM` of the slot id: it can only ever remove its own slot.
 */
export const CONN_COUNT_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  return 1
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  return 0
end
redis.call('ZADD', KEYS[1], math.max(now + tonumber(ARGV[3]), tonumber(ARGV[4])), ARGV[1])
local latest = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
redis.call('PEXPIREAT', KEYS[1], latest[2])
return 1
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    appConnSlot(
      key: string,
      slotId: string,
      cap: number,
      ttlMs: number,
      tokenDeadlineMs: number,
    ): Result<number, Context>;
  }
}
