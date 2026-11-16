import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { immudbConfig } from '@platform/config';
import { describe, expect, it } from 'vitest';
import { loadImmudbMigrations, runImmudbMigrations, splitImmudbSql } from './immudb-migrations.js';

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'immudb-mig-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

describe('immudb migrations', () => {
  it('splits statements and drops comments', () => {
    expect(
      splitImmudbSql(
        '-- header\nCREATE TABLE IF NOT EXISTS a (id VARCHAR[8], PRIMARY KEY id);\n\n' +
          'CREATE INDEX IF NOT EXISTS ON a(id); -- trailing\n',
      ),
    ).toEqual([
      'CREATE TABLE IF NOT EXISTS a (id VARCHAR[8], PRIMARY KEY id)',
      'CREATE INDEX IF NOT EXISTS ON a(id)',
    ]);
  });

  it('loads files in version order with ids and checksums', async () => {
    const dir = dirWith({
      '002_b.sql': 'CREATE INDEX IF NOT EXISTS ON a(id);',
      '001_a.sql': 'CREATE TABLE IF NOT EXISTS a (id VARCHAR[8], PRIMARY KEY id);',
    });
    const files = await loadImmudbMigrations([{ name: 'src', dir }]);
    expect(files.map((f) => f.id)).toEqual(['src/001_a.sql', 'src/002_b.sql']);
    expect(files[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [
      { 'one.sql': 'CREATE TABLE IF NOT EXISTS a (id VARCHAR[8], PRIMARY KEY id);' },
      /NNN_name\.sql/,
    ],
    [
      {
        '001_a.sql': 'CREATE TABLE IF NOT EXISTS a (id VARCHAR[8], PRIMARY KEY id);',
        '001_b.sql': '',
      },
      /version 001 is used twice/,
    ],
    [{ '001_a.sql': 'CREATE TABLE a (id VARCHAR[8], PRIMARY KEY id);' }, /IF NOT EXISTS/],
    [{ '001_a.sql': "INSERT INTO a (id) VALUES ('x');" }, /IF NOT EXISTS/],
  ])('rejects %o', async (files, message) => {
    await expect(loadImmudbMigrations([{ name: 'src', dir: dirWith(files) }])).rejects.toThrow(
      message,
    );
  });

  it('rejects a source listed twice', async () => {
    const dir = dirWith({});
    await expect(
      loadImmudbMigrations([
        { name: 'src', dir },
        { name: 'src', dir },
      ]),
    ).rejects.toThrow(/listed twice/);
  });

  it('needs the admin password before touching the server', async () => {
    await expect(runImmudbMigrations(immudbConfig.parse({}), [])).rejects.toThrow(
      /IMMUDB_ADMIN_PASSWORD/,
    );
  });
});
