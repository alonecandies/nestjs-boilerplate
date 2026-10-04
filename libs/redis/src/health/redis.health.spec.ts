import { HealthIndicatorService } from '@nestjs/terminus';
import { describe, expect, it } from 'vitest';
import { InMemoryRedis } from '../testing/in-memory-redis.js';
import { RedisHealthIndicator } from './redis.health.js';

describe('RedisHealthIndicator', () => {
  it('is up with the PING latency when connected', async () => {
    const indicator = new RedisHealthIndicator(
      new InMemoryRedis().asRedis(),
      new HealthIndicatorService(),
    );
    const result = await indicator.check();
    expect(result.redis?.status).toBe('up');
    expect(result.redis).toHaveProperty('latencyMs');
  });

  it('is down without issuing PING while reconnecting', async () => {
    const redis = new InMemoryRedis();
    redis.simulateOutage('reconnecting');
    const indicator = new RedisHealthIndicator(redis.asRedis(), new HealthIndicatorService());
    const result = await indicator.check();
    expect(result.redis?.status).toBe('down');
    expect(JSON.stringify(result)).toContain('connection is reconnecting');
    expect(redis.calls).not.toContain('ping');
  });
});
