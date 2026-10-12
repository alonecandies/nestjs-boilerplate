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
    const [identity, billing] = [set('identity'), set('billing')];
    expect(withPlatformMigrations([identity, billing])).toEqual([
      platformMigrations,
      identity,
      billing,
    ]);
    expect(withPlatformMigrations([billing, identity])).toEqual([
      platformMigrations,
      billing,
      identity,
    ]);
  });

  it('applies the platform set alone for a process that owns no tables', () => {
    expect(withPlatformMigrations([])).toEqual([platformMigrations]);
  });

  it('rejects the platform set passed by the caller: it always runs first', () => {
    expect(() => withPlatformMigrations([set('identity'), platformMigrations])).toThrow(
      /"platform" is listed twice/,
    );
  });

  it('rejects a set listed twice', () => {
    const identity = set('identity');
    expect(() => withPlatformMigrations([identity, identity])).toThrow(
      /"identity" is listed twice/,
    );
  });

  it('rejects two sets sharing one bookkeeping table (drizzle would skip the older files)', () => {
    expect(() =>
      withPlatformMigrations([set('identity'), set('audit', { migrationsSchema: 'identity' })]),
    ).toThrow(/"identity" and "audit" share identity\.__drizzle_migrations/);
    expect(() => withPlatformMigrations([set('ledger', { migrationsSchema: 'app' })])).toThrow(
      /"platform" and "ledger" share app\.__drizzle_migrations/,
    );
  });
});
