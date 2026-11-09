import { describe, expect, it } from 'vitest';
import type { DatabaseMigrationSet } from '../database.types.js';
import { platformMigrations } from '../platform/platform.migrations.js';
import { withPlatformMigrations } from './migration-sets.js';
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
