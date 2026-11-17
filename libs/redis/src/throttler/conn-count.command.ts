import type { Result } from 'ioredis';

export const CONN_COUNT_COMMAND = 'appConnCount';

/**
 * KEYS[1] counter. ARGV[1] delta (+1 / -1), ARGV[2] cap, ARGV[3] key ttl ms.
 * Returns { count, admitted (0|1) }. Never below 0; refused increments are rolled back.
 */
export const CONN_COUNT_SCRIPT = `
local delta = tonumber(ARGV[1])
local n = redis.call('INCRBY', KEYS[1], delta)
if n < 0 then
  redis.call('SET', KEYS[1], 0)
  n = 0
end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
if delta > 0 and n > tonumber(ARGV[2]) then
  redis.call('DECRBY', KEYS[1], delta)
  return { n - delta, 0 }
end
return { n, 1 }
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    appConnCount(
      key: string,
      delta: number,
      cap: number,
      ttlMs: number,
    ): Result<[number, number], Context>;
  }
}
