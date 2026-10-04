import { HealthIndicatorService } from '@nestjs/terminus';
import { describe, expect, it, vi } from 'vitest';
import { createFakeCassandraClient, type FakeCqlHandler } from '../../test/fake-cassandra.js';
import { CassandraHealthIndicator } from './cassandra.health.js';

// Abstract marker class; mocked so the test does not load observability's module graph.
vi.mock('@app/observability', () => ({ HealthContributor: class HealthContributor {} }));

const indicator = (handler?: FakeCqlHandler) => {
  const fake = createFakeCassandraClient(handler);
  return { health: new CassandraHealthIndicator(fake.client, new HealthIndicatorService()), fake };
};

describe('CassandraHealthIndicator', () => {
  it('reports up under "cassandra" after a bounded, idempotent system.local read', async () => {
    const { health, fake } = indicator(() => ({ rows: [{ release_version: '5.0.5' }] }));
    expect(health.key).toBe('cassandra');
    await expect(health.check()).resolves.toMatchObject({ cassandra: { status: 'up' } });
    expect(fake.executed).toEqual([
      {
        query: 'SELECT release_version FROM system.local',
        params: [],
        options: { prepare: true, isIdempotent: true, readTimeout: 2_000 },
      },
    ]);
  });

  it('reports down (without throwing) when no host answers', async () => {
    const { health } = indicator(() => {
      throw new Error('All host(s) tried for query failed');
    });
    await expect(health.check()).resolves.toMatchObject({ cassandra: { status: 'down' } });
  });
});
