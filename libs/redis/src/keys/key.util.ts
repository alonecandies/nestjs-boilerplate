/** A segment of a Redis key. Numbers are allowed for ids/counters. */
export type RedisKeyPart = string | number;

/** Separator between key segments (Redis convention; RedisInsight/`redis-cli --scan` group by it). */
export const REDIS_KEY_SEPARATOR = ':';

/** Narrowing helper shared by guards/services that read untyped request/claim fields. */
export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

function assertPart(part: RedisKeyPart, index: number): void {
  if (typeof part === 'number' ? !Number.isFinite(part) : part.length === 0) {
    throw new TypeError(`Redis key segment #${index} must be a non-empty string or finite number`);
  }
}

/**
 * Builds `prefix:part1:part2…`. Pure and allocation-light because it runs on hot paths
 * (throttling, denylist, locks). Empty segments are rejected: `app::x` keys are a classic source of
 * collisions between features.
 *
 * Why not ioredis `keyPrefix`: BullMQ rejects prefixed connections and redlock/Lua scripts would see
 * double-prefixed keys (research data-libs §3.6/§7.25) — prefixing is done here, explicitly.
 */
export function joinKey(prefix: string, ...parts: readonly RedisKeyPart[]): string {
  if (prefix.length === 0) throw new TypeError('Redis key prefix must not be empty');
  let key = prefix;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] as RedisKeyPart;
    assertPart(part, index);
    key += REDIS_KEY_SEPARATOR + String(part);
  }
  return key;
}

/**
 * Wraps a value in a Redis Cluster hash tag (`{value}`) so every key containing it maps to the same
 * slot — required for multi-key Lua scripts (e.g. the throttler's hits + block keys).
 */
export function hashTag(value: RedisKeyPart): string {
  assertPart(value, 0);
  return `{${String(value)}}`;
}
