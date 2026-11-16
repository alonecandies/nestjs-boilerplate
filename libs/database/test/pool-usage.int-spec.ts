import { startTestPostgres, type TestPostgres } from '@platform/testing/postgres';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PoolUsage } from '../src/drizzle/pool-usage.js';

describe.skipIf(process.env['INTEGRATION'] !== '1')('PoolUsage on a real postgres.js pool', () => {
  let pg: TestPostgres | undefined;
  let url: string;

  beforeAll(async () => {
    pg = await startTestPostgres();
    url = pg.url;
  });

  afterAll(async () => {
    await pg?.stop();
  });

  it('reports max connections in use and the rest waiting', async () => {
    const client = postgres(url, { max: 2, onnotice: () => undefined });
    const usage = new PoolUsage('runtime', 2);
    const sql = usage.track(client);
    try {
      const all = Promise.all([1, 2, 3, 4].map(() => sql`select pg_sleep(0.4)`));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(usage.snapshot()).toEqual({ pool: 'runtime', max: 2, inUse: 2, waiting: 2 });
      await all;
      expect(usage.snapshot()).toMatchObject({ inUse: 0, waiting: 0 });
    } finally {
      await client.end({ timeout: 1 });
    }
  });

  it('counts a transaction once and releases failed queries', async () => {
    const client = postgres(url, { max: 2, onnotice: () => undefined });
    const usage = new PoolUsage('runtime', 2);
    const sql = usage.track(client);
    try {
      let inside: number | undefined;
      await sql.begin(async (tx) => {
        await tx`select 1`;
        await tx`select 2`;
        inside = usage.snapshot().inUse;
      });
      expect(inside).toBe(1);
      await expect(sql`select 1/0`).rejects.toThrow();
      expect(usage.snapshot()).toMatchObject({ inUse: 0, waiting: 0 });
    } finally {
      await client.end({ timeout: 1 });
    }
  });
});
