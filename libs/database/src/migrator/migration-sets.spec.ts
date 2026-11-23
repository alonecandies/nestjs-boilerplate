import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  describe('online steps', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'migration-sets-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    /** A set on disk: a journal listing `tags` and an `online/` folder holding `files`. */
    const onDisk = (
      name: string,
      tags: string[],
      files: Record<string, string>,
    ): DatabaseMigrationSet => {
      const folder = join(dir, name);
      const onlineFolder = join(folder, 'online');
      mkdirSync(join(folder, 'meta'), { recursive: true });
      mkdirSync(onlineFolder);
      const entries = tags.map((tag, idx) => ({
        idx,
        when: 1_700_000_000_000 + idx,
        tag,
        breakpoints: true,
      }));
      writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ entries }));
      for (const [file, text] of Object.entries(files))
        writeFileSync(join(onlineFolder, file), text);
      return set(name, { folder, onlineFolder });
    };
    const VALIDATE = 'ALTER TABLE orders.orders VALIDATE CONSTRAINT orders_b_check;';

    it('accepts sets sharing a schema when at most one of them has online steps', () => {
      expect(() =>
        assertMigrationSets([
          platformMigrations,
          onDisk('orders', ['0000_init'], { '0000_b.sql': VALIDATE }),
          set('audit', { migrationsSchema: 'orders', migrationsTable: '__audit_migrations' }),
        ]),
      ).not.toThrow();
    });

    it('accepts several steps anchored at one file, and steps anchored at any file of the journal', () => {
      expect(() =>
        assertMigrationSets([
          platformMigrations,
          onDisk('orders', ['0000_init', '0001_more'], {
            '0000_a.sql': VALIDATE,
            '0000_b.sql': VALIDATE,
            '0001_c.sql': VALIDATE,
          }),
        ]),
      ).not.toThrow();
    });

    it('rejects a step anchored beyond the journal, also through withPlatformMigrations', () => {
      const orders = onDisk('orders', ['0000_init', '0001_more'], { '0002_c.sql': VALIDATE });
      const beyond =
        /Migration set "orders": online step 0002_c\.sql \(.*\) is anchored at 0002, beyond the set's journal \(2 file\(s\), the last is 0001_more\)/;
      expect(() => assertMigrationSets([platformMigrations, orders])).toThrow(beyond);
      expect(() => withPlatformMigrations([orders])).toThrow(beyond);
    });

    it('rejects a declared online folder that does not exist', () => {
      expect(() =>
        assertMigrationSets([
          platformMigrations,
          set('orders', { onlineFolder: join(dir, 'missing') }),
        ]),
      ).toThrow(/Migration set "orders" declares online steps in .*missing, which does not exist/);
    });
  });
});
