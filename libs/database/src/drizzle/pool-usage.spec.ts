import type { Sql } from 'postgres';
import { register } from 'prom-client';
import { PoolUsage, registerPoolUsage } from './pool-usage.js';

/** postgres.js queries are promises with chainable modifiers such as `.values()`. */
interface LazyQuery extends Promise<unknown[]> {
  values(): LazyQuery;
}

/** A postgres.js-shaped client whose queries settle when the test releases them. */
function fakeSql() {
  const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const query = () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown[]>((ok, ko) => {
      resolve = () => ok([]);
      reject = ko;
    });
    pending.push({ resolve, reject });
    // A real promise (Biome's noThenProperty rejects an object literal with a `then` key).
    const lazy: LazyQuery = Object.assign(promise, { values: (): LazyQuery => lazy });
    return lazy;
  };
  // A tagged template runs a query; `sql(value)` returns a helper (no `then`), as in postgres.js.
  const sql = Object.assign(
    (strings: unknown) => (Array.isArray(strings) ? query() : { strings }),
    {
      unsafe: (..._args: unknown[]) => query(),
      begin: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    },
  );
  return { sql: sql as unknown as Sql, pending };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('PoolUsage', () => {
  it('counts an awaited query until it settles, and never a query that is only built', async () => {
    const usage = new PoolUsage('runtime', 2);
    const { sql, pending } = fakeSql();
    const tracked = usage.track(sql);
    void tracked.unsafe('select 1'); // built, never awaited (a fragment): not counted
    expect(tracked('ident' as never)).not.toHaveProperty('then'); // sql('x') helpers pass through
    expect(usage.snapshot()).toEqual({ pool: 'runtime', max: 2, inUse: 0, waiting: 0 });
    const running = Promise.all([
      tracked.unsafe('select 2').values(),
      tracked`select 3`,
      tracked.unsafe('select 4'),
    ]);
    await tick();
    expect(usage.snapshot()).toEqual({ pool: 'runtime', max: 2, inUse: 2, waiting: 1 });
    for (const query of pending) query.resolve();
    await running;
    expect(usage.snapshot()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('releases a failed query', async () => {
    const usage = new PoolUsage('runtime', 1);
    const { sql, pending } = fakeSql();
    const failing = usage.track(sql).unsafe('select 1/0');
    const settled = Promise.resolve(failing).catch(() => 'failed');
    await tick();
    expect(usage.snapshot().inUse).toBe(1);
    pending[0]?.reject(new Error('division by zero'));
    await expect(settled).resolves.toBe('failed');
    expect(usage.snapshot().inUse).toBe(0);
  });

  it('counts a transaction once, for its whole callback', async () => {
    const usage = new PoolUsage('runtime', 4);
    const { sql } = fakeSql();
    let inside: number | undefined;
    await usage.track(sql).begin(async () => {
      inside = usage.snapshot().inUse;
    });
    expect(inside).toBe(1);
    expect(usage.snapshot().inUse).toBe(0);
  });

  it('exposes the gauges per pool', async () => {
    const usage = new PoolUsage('unit-pool', 5);
    registerPoolUsage(usage);
    const max = await register.getSingleMetric('db_pool_connections_max')?.get();
    expect(max?.values).toContainEqual(
      expect.objectContaining({ labels: { pool: 'unit-pool' }, value: 5 }),
    );
    const inUse = await register.getSingleMetric('db_pool_connections_in_use')?.get();
    expect(inUse?.values).toContainEqual(
      expect.objectContaining({ labels: { pool: 'unit-pool' }, value: 0 }),
    );
    expect(register.getSingleMetric('db_pool_operations_waiting')).toBeDefined();
  });
});
