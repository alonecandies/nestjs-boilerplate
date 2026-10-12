import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_TABLE } from '../migrator/migrations.constants.js';
import { platformMigrations } from './platform.migrations.js';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

const readJournal = (): Journal =>
  JSON.parse(
    readFileSync(join(platformMigrations.folder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;

describe('platformMigrations', () => {
  it('is the platform set: src/platform/migrations, bookkeeping in app.__drizzle_migrations', () => {
    expect(platformMigrations).toEqual({
      name: 'platform',
      folder: join(import.meta.dirname, 'migrations'),
      migrationsSchema: 'app',
      migrationsTable: MIGRATIONS_TABLE,
    });
  });

  it('has a hand-written journal drizzle can apply: one entry per file, in order', () => {
    const journal = readJournal();
    expect(journal).toMatchObject({ version: '7', dialect: 'postgresql' });
    expect(journal.entries.length).toBeGreaterThan(0);
    let previousWhen = 0;
    for (const [index, entry] of journal.entries.entries()) {
      expect(entry).toMatchObject({ idx: index, version: '7', breakpoints: true });
      expect(entry.tag.startsWith(`${String(index).padStart(4, '0')}_`)).toBe(true);
      // drizzle applies only files whose `when` is newer than the last applied one.
      expect(entry.when).toBeGreaterThan(previousWhen);
      previousWhen = entry.when;
      expect(existsSync(join(platformMigrations.folder, `${entry.tag}.sql`))).toBe(true);
    }
    const files = readdirSync(platformMigrations.folder).filter((file) => file.endsWith('.sql'));
    expect(files.toSorted()).toEqual(journal.entries.map((entry) => `${entry.tag}.sql`));
  });

  it('0000_init creates the app schema and pg_trgm in public', () => {
    const sql = readFileSync(join(platformMigrations.folder, '0000_init.sql'), 'utf8');
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "app";');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;');
  });
});
