import { Logger } from '@nestjs/common';
import { register } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkRedisEvictionPolicy,
  REDIS_EVICTION_POLICY_SAFE,
  readMaxmemoryPolicy,
} from './redis-eviction-check.js';
import { InMemoryRedis } from './testing/in-memory-redis.js';

/** The gauge's samples, `undefined` when it was never registered. */
async function samples(): Promise<{ value: number }[] | undefined> {
  const metric = register.getSingleMetric(REDIS_EVICTION_POLICY_SAFE);
  return metric === undefined ? undefined : (await metric.get()).values;
}

describe('readMaxmemoryPolicy', () => {
  it('reads the policy from INFO memory text', () => {
    expect(
      readMaxmemoryPolicy('# Memory\r\nused_memory:1\r\nmaxmemory_policy:allkeys-lru\r\n'),
    ).toBe('allkeys-lru');
  });

  it('is undefined when the server does not print it', () => {
    expect(readMaxmemoryPolicy('# Memory\r\nused_memory:1\r\n')).toBeUndefined();
  });
});

describe('checkRedisEvictionPolicy', () => {
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    register.removeSingleMetric(REDIS_EVICTION_POLICY_SAFE);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    error.mockRestore();
    register.removeSingleMetric(REDIS_EVICTION_POLICY_SAFE);
  });

  it('logs one structured error and sets the gauge to 0 for an evicting policy', async () => {
    const redis = new InMemoryRedis({ maxmemoryPolicy: 'allkeys-lru' });
    await checkRedisEvictionPolicy(redis.asRedis());
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      policy: 'allkeys-lru',
      required: 'noeviction',
    });
    expect(await samples()).toEqual([expect.objectContaining({ value: 0 })]);
  });

  it('sets the gauge to 1 and logs nothing for noeviction', async () => {
    const redis = new InMemoryRedis({ maxmemoryPolicy: 'noeviction' });
    await checkRedisEvictionPolicy(redis.asRedis());
    expect(error).not.toHaveBeenCalled();
    expect(await samples()).toEqual([expect.objectContaining({ value: 1 })]);
  });

  it('sets no gauge when the server hides the policy', async () => {
    const redis = new InMemoryRedis({ maxmemoryPolicy: null });
    await checkRedisEvictionPolicy(redis.asRedis());
    expect(error).not.toHaveBeenCalled();
    expect(await samples()).toBeUndefined();
  });

  it('sets no gauge and does not throw when INFO fails', async () => {
    const redis = new InMemoryRedis({ maxmemoryPolicy: 'allkeys-lru' });
    redis.simulateOutage();
    await expect(checkRedisEvictionPolicy(redis.asRedis())).resolves.toBeUndefined();
    expect(error).not.toHaveBeenCalled();
    expect(await samples()).toBeUndefined();
  });
});
