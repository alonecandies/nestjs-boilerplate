import { HealthIndicatorService } from '@nestjs/terminus';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeSql, type FakeSqlHandler } from '../../test/fake-sql.js';
import type { DrizzleDB } from '../drizzle/drizzle.types.js';
import { DatabaseHealthIndicator } from './database.health.js';

// Abstract marker class; mocked so the test does not load observability's module graph.
vi.mock('@app/observability', () => ({ HealthContributor: class HealthContributor {} }));

const indicator = (
  handler?: FakeSqlHandler,
): { health: DatabaseHealthIndicator; sql: ReturnType<typeof createFakeSql> } => {
  const sql = createFakeSql(handler);
  const db = { $client: sql } as unknown as DrizzleDB;
  return { health: new DatabaseHealthIndicator(db, new HealthIndicatorService()), sql };
};

describe('DatabaseHealthIndicator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports up under the "postgres" key after a select 1 on the pool', async () => {
    const { health, sql } = indicator();
    expect(health.key).toBe('postgres');
    await expect(health.check()).resolves.toMatchObject({ postgres: { status: 'up' } });
    expect(sql.queries).toEqual(['select 1']);
  });

  it('reports down (without throwing) when the query fails', async () => {
    const { health } = indicator(() => {
      throw new Error('connection refused');
    });
    await expect(health.check()).resolves.toMatchObject({ postgres: { status: 'down' } });
  });

  it('times out a stuck query, reports down and cancels it to free the connection', async () => {
    vi.useFakeTimers();
    const { health, sql } = indicator(() => new Promise<unknown[]>(() => undefined));
    const result = health.check();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toMatchObject({ postgres: { status: 'down' } });
    expect(sql.cancels).toHaveBeenCalledTimes(1);
  });
});
