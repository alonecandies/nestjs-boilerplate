import { getOrCreateGauge } from '@platform/observability';
import type { Sql } from 'postgres';

export const DB_POOL_CONNECTIONS_IN_USE = 'db_pool_connections_in_use';
export const DB_POOL_OPERATIONS_WAITING = 'db_pool_operations_waiting';
export const DB_POOL_CONNECTIONS_MAX = 'db_pool_connections_max';

export interface PoolUsageSnapshot {
  readonly pool: string;
  readonly max: number;
  readonly inUse: number;
  readonly waiting: number;
}

type Settle = (value: unknown) => unknown;
type Then = (onFulfilled?: Settle, onRejected?: Settle) => PromiseLike<unknown>;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

/**
 * Connection demand of one postgres.js pool. postgres.js keeps its connection queues private, so
 * this counts operations instead: a top-level query from the moment it is awaited (postgres.js
 * queries are lazy: a built-but-never-awaited query or fragment runs nothing) until it settles, and a
 * `begin()` transaction for its whole callback. `inUse = min(outstanding, max)`; the rest waits for
 * (or is pipelined behind) another operation on the same connection. Not counted: `reserve()`,
 * `listen()`, the migration client.
 */
export class PoolUsage {
  private outstanding = 0;

  constructor(
    readonly pool: string,
    readonly max: number,
  ) {}

  snapshot(): PoolUsageSnapshot {
    return {
      pool: this.pool,
      max: this.max,
      inUse: Math.min(this.outstanding, this.max),
      waiting: Math.max(0, this.outstanding - this.max),
    };
  }

  /** A wrapper of `client` (the client itself is not modified) whose operations are counted. */
  track<T extends Sql>(client: T): T {
    const unsafe = client.unsafe.bind(client) as (...args: unknown[]) => PromiseLike<unknown>;
    const begin = client.begin.bind(client) as (...args: unknown[]) => Promise<unknown>;
    const countedUnsafe = (...args: unknown[]) => this.countWhenAwaited(unsafe(...args));
    const countedBegin = async (...args: unknown[]): Promise<unknown> => {
      this.outstanding += 1;
      try {
        return await begin(...args);
      } finally {
        this.outstanding -= 1;
      }
    };
    return new Proxy(client, {
      // Tagged-template calls (sql`select …`) return a lazy query; `sql(value)` returns a helper
      // (identifier, values list), which has no `then` and passes through uncounted.
      apply: (target, thisArg, args: unknown[]) => {
        const result: unknown = Reflect.apply(target, thisArg, args);
        return isThenable(result) ? this.countWhenAwaited(result) : result;
      },
      get: (target, property, receiver) => {
        if (property === 'unsafe') return countedUnsafe;
        if (property === 'begin') return countedBegin;
        return Reflect.get(target, property, receiver);
      },
    });
  }

  /** Wraps the query's own `then` (postgres.js starts a query on its first `then`). */
  private countWhenAwaited<Q extends PromiseLike<unknown>>(query: Q): Q {
    const then = query.then.bind(query) as Then;
    let started = false;
    Object.defineProperty(query, 'then', {
      configurable: true,
      writable: true,
      value: (onFulfilled?: Settle, onRejected?: Settle) => {
        if (started) return then(onFulfilled, onRejected);
        started = true;
        this.outstanding += 1;
        return then(
          (value) => {
            this.outstanding -= 1;
            return onFulfilled ? onFulfilled(value) : value;
          },
          (reason) => {
            this.outstanding -= 1;
            if (onRejected) return onRejected(reason);
            throw reason;
          },
        );
      },
    });
    return query;
  }
}

const pools = new Map<string, PoolUsage>();
type GaugeSpec = readonly [
  name: string,
  help: string,
  read: (snapshot: PoolUsageSnapshot) => number,
];
const GAUGES: readonly GaugeSpec[] = [
  [DB_POOL_CONNECTIONS_IN_USE, 'Postgres pool connections in use, by pool', (s) => s.inUse],
  [
    DB_POOL_OPERATIONS_WAITING,
    'Postgres operations waiting for a connection (beyond the pool size), by pool',
    (s) => s.waiting,
  ],
  [DB_POOL_CONNECTIONS_MAX, 'Postgres pool size (max connections), by pool', (s) => s.max],
];

/** Publishes `usage` as `db_pool_*{pool}` (one entry per pool name; the latest registration wins). */
export function registerPoolUsage(usage: PoolUsage): void {
  pools.set(usage.pool, usage);
  for (const [name, help, read] of GAUGES) {
    getOrCreateGauge({
      name,
      help,
      labelNames: ['pool'],
      collect() {
        this.reset();
        for (const pool of pools.values()) this.set({ pool: pool.pool }, read(pool.snapshot()));
      },
    });
  }
}
