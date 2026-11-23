import { describe, expect, it } from 'vitest';
import type { DatabaseMigrationSet } from '../database.types.js';
import { platformMigrations } from '../platform/platform.migrations.js';
import { assertMigrationSets, withPlatformMigrations } from './migration-sets.js';
import { MIGRATIONS_TABLE } from './migrations.constants.js';

const set = (
  name: string,
  overrides: Partial<DatabaseMigrationSet> = {},
): DatabaseMigrationSet => ({
  name,
  folder: `/migrations/${name}`,
  migrationsSchema: name,
  migrationsTable: MIGRATIONS_TABLE,
  ...overrides,
});

describe('withPlatformMigrations', () => {
  it('puts the platform set first, then the given sets in array order', () => {
    const [orders, catalog] = [set('orders'), set('catalog')];
    expect(withPlatformMigrations([orders, catalog])).toEqual([
      platformMigrations,
      orders,
      catalog,
    ]);
    expect(withPlatformMigrations([catalog, orders])).toEqual([
      platformMigrations,
      catalog,
      orders,
    ]);
  });

  it('applies the platform set alone for a process that owns no tables', () => {
    expect(withPlatformMigrations([])).toEqual([platformMigrations]);
  });

  it('rejects the platform set passed by the caller: it always runs first', () => {
    expect(() => withPlatformMigrations([set('orders'), platformMigrations])).toThrow(
      /"platform" is listed twice/,
    );
  });

  it('rejects a set listed twice', () => {
    const orders = set('orders');
    expect(() => withPlatformMigrations([orders, orders])).toThrow(/"orders" is listed twice/);
  });

  it('rejects two sets sharing one bookkeeping table (drizzle would skip the older files)', () => {
    expect(() =>
      withPlatformMigrations([set('orders'), set('audit', { migrationsSchema: 'orders' })]),
    ).toThrow(/"orders" and "audit" share orders\.__drizzle_migrations/);
    expect(() => withPlatformMigrations([set('ledger', { migrationsSchema: 'app' })])).toThrow(
      /"platform" and "ledger" share app\.__drizzle_migrations/,
    );
  });
});

describe('assertMigrationSets (what runMigrations checks before it connects)', () => {
  it('accepts the platform set first, then sets with their own bookkeeping tables', () => {
    expect(() => assertMigrationSets([platformMigrations])).not.toThrow();
    expect(() =>
      assertMigrationSets([platformMigrations, set('orders'), set('catalog')]),
    ).not.toThrow();
    expect(() => assertMigrationSets(withPlatformMigrations([set('orders')]))).not.toThrow();
  });

  it.each([
    ['no set at all', [] as DatabaseMigrationSet[]],
    ['a domain set alone', [set('orders')]],
    ['the platform set second', [set('orders'), platformMigrations]],
    [
      'a look-alike named "platform" from another folder',
      [{ ...platformMigrations, folder: '/elsewhere' }, set('orders')],
    ],
  ])('rejects %s: the platform set must run first', (_label, sets) => {
    expect(() => assertMigrationSets(sets)).toThrow(
      /The platform migration set must run first .*withPlatformMigrations/,
    );
  });

  it('rejects a set listed twice and two sets sharing one bookkeeping table', () => {
    const orders = set('orders');
    expect(() => assertMigrationSets([platformMigrations, orders, orders])).toThrow(
      /"orders" is listed twice/,
    );
    expect(() =>
      assertMigrationSets([
        platformMigrations,
        set('orders'),
        set('audit', { migrationsSchema: 'orders' }),
      ]),
    ).toThrow(/"orders" and "audit" share orders\.__drizzle_migrations/);
  });

  it('rejects two sets with online steps in one schema: they would share its __online_migrations', () => {
    expect(() =>
      assertMigrationSets([
        platformMigrations,
        set('orders', { onlineFolder: '/migrations/orders/online' }),
        set('audit', {
          migrationsSchema: 'orders',
          migrationsTable: '__audit_migrations',
          onlineFolder: '/migrations/audit/online',
        }),
      ]),
    ).toThrow(/"orders" and "audit" both have online steps in schema orders/);
  });

  it('accepts sets sharing a schema when at most one of them has online steps', () => {
    expect(() =>
      assertMigrationSets([
        platformMigrations,
        set('orders', { onlineFolder: '/migrations/orders/online' }),
        set('audit', { migrationsSchema: 'orders', migrationsTable: '__audit_migrations' }),
      ]),
    ).not.toThrow();
  });
});
