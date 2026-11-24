import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  anchoredAt0000,
  anchoredMigrations,
  gizmosMigrations,
  gizmosWithOnline,
} from '../../test/fixtures/fixture-sets.js';
import type { DatabaseMigrationSet } from '../database.types.js';
import { platformMigrations } from '../platform/platform.migrations.js';
import { readOnlineSteps } from './migration-files.js';
import { MIGRATIONS_TABLE } from './migrations.constants.js';

const VALIDATE = 'ALTER TABLE orders.orders VALIDATE CONSTRAINT orders_b_check;';

describe('readOnlineSteps: an online step follows the migration its number names', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'migration-files-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A set on disk: a journal listing `tags` and an `online/` folder holding `files`. */
  const onDisk = (tags: string[], files: Record<string, string>): DatabaseMigrationSet => {
    const folder = join(dir, 'orders');
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
    for (const [file, text] of Object.entries(files)) writeFileSync(join(onlineFolder, file), text);
    return {
      name: 'orders',
      folder,
      migrationsSchema: 'orders',
      migrationsTable: MIGRATIONS_TABLE,
      onlineFolder,
    };
  };

  it('refuses a step whose journal entry carries another number (a hand-edited journal)', () => {
    const orders = onDisk(['0000_init', '0005_x'], { '0001_y.sql': VALIDATE });
    expect(() => readOnlineSteps(orders)).toThrow(
      /Migration set "orders": online step 0001_y\.sql \(.*\) is anchored at 0001, but the journal's entry 0001 is 0005_x/,
    );
  });

  it('refuses a step whose journal entry has no number at all', () => {
    const orders = onDisk(['0000_init', 'more'], { '0001_y.sql': VALIDATE });
    expect(() => readOnlineSteps(orders)).toThrow(
      /online step 0001_y\.sql \(.*\) is anchored at 0001, but the journal's entry 0001 is more/,
    );
  });

  it('accepts steps whose number is their migration’s', () => {
    const orders = onDisk(['0000_init', '0001_more'], {
      '0000_a.sql': VALIDATE,
      '0001_b.sql': VALIDATE,
    });
    expect(readOnlineSteps(orders).map(({ name, anchor }) => ({ name, anchor }))).toEqual([
      { name: '0000_a.sql', anchor: 0 },
      { name: '0001_b.sql', anchor: 1 },
    ]);
  });

  it("loads the repo's own sets: the platform set and every fixture with online steps", () => {
    expect(readOnlineSteps(platformMigrations)).toEqual([]);
    for (const set of [
      gizmosMigrations,
      gizmosWithOnline('online-retry'),
      gizmosWithOnline('online-two-statements'),
      anchoredMigrations,
      anchoredAt0000,
    ]) {
      expect(readOnlineSteps(set).length, set.onlineFolder).toBeGreaterThan(0);
    }
  });
});
