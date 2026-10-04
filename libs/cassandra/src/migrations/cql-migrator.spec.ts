import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoggerService } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeCassandraClient, type FakeResult } from '../../test/fake-cassandra.js';
import { CQL_MIGRATIONS_TABLE, CqlMigrator, loadCqlMigrations } from './cql-migrator.js';

const silentLogger = (): LoggerService => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

/** Writes `files` into a fresh folder under `root`. */
const folder = (root: string, name: string, files: Record<string, string>): string => {
  const dir = join(root, name);
  mkdirSync(dir);
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return dir;
};

interface MigrationRow {
  version: string;
  checksum: string;
  status: string;
  claimed_by: string;
}

/**
 * In-memory `<ks>.schema_migrations` honouring the LWT semantics the migrator relies on:
 * INSERT … IF NOT EXISTS returns the blocking row, UPDATE … IF status = ? is conditional.
 */
function migrationsStore(options: { failOn?: RegExp; onDdl?: (cql: string) => void } = {}) {
  const rows = new Map<string, MigrationRow>();
  const ddl: string[] = [];
  const fake = createFakeCassandraClient((query, params): FakeResult => {
    const values = params as unknown[];
    if (query.startsWith(`CREATE TABLE IF NOT EXISTS app.${CQL_MIGRATIONS_TABLE}`)) return {};
    if (query.startsWith('SELECT version, status, checksum')) {
      return { rows: [...rows.values()].map((row) => ({ ...row })) };
    }
    if (query.startsWith(`INSERT INTO app.${CQL_MIGRATIONS_TABLE}`)) {
      const [version, checksum, status, claimedBy] = values as string[];
      const existing = rows.get(version ?? '');
      if (existing) return { applied: false, rows: [{ ...existing }] };
      rows.set(version ?? '', {
        version: version ?? '',
        checksum: checksum ?? '',
        status: status ?? '',
        claimed_by: claimedBy ?? '',
      });
      return { applied: true };
    }
    if (query.startsWith(`UPDATE app.${CQL_MIGRATIONS_TABLE}`)) {
      const [next, version, expected] = values as string[];
      const row = rows.get(version ?? '');
      if (row === undefined || row.status !== expected) return { applied: false };
      row.status = next ?? '';
      return { applied: true };
    }
    if (query.startsWith(`DELETE FROM app.${CQL_MIGRATIONS_TABLE}`)) {
      rows.delete((values as string[])[0] ?? '');
      return { applied: true };
    }
    if (options.failOn?.test(query)) throw new Error('SyntaxException: line 1:0');
    ddl.push(query);
    options.onDdl?.(query);
    return {};
  });
  return { ...fake, rows, ddl };
}

describe('loadCqlMigrations', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cql-migrations-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('orders by numeric prefix within a folder and keeps folder order across folders', () => {
    const first = folder(root, 'first', {
      '10_c.cql': 'SELECT 10;',
      '2_b.cql': 'SELECT 2;',
      '001_a.cql': 'SELECT 1;',
      'README.md': 'ignored',
    });
    const second = folder(root, 'second', { '001_z.cql': 'SELECT 100;' });
    const migrations = loadCqlMigrations([{ dir: first }, { dir: second }]);
    expect(migrations.map((m) => m.version)).toEqual(['001_a', '2_b', '10_c', '001_z']);
    expect(migrations[0]).toMatchObject({ sequence: 1, statements: ['SELECT 1'] });
  });

  it('splits files into statements', () => {
    const dir = folder(root, 'm', {
      '001_init.cql': 'CREATE TABLE t (id int PRIMARY KEY);\n-- note\nCREATE INDEX i ON t (id);',
    });
    expect(loadCqlMigrations([{ dir }])[0]?.statements).toEqual([
      'CREATE TABLE t (id int PRIMARY KEY)',
      'CREATE INDEX i ON t (id)',
    ]);
  });

  it('checksums ignore comments and whitespace but not content', () => {
    const a = folder(root, 'a', { '001_x.cql': 'CREATE TABLE t (id int PRIMARY KEY);' });
    const b = folder(root, 'b', {
      '001_x.cql': '-- reformatted\nCREATE TABLE t (\n  id int PRIMARY KEY\n) ;',
    });
    const c = folder(root, 'c', { '001_x.cql': 'CREATE TABLE t (id bigint PRIMARY KEY);' });
    const [ma, mb, mc] = [a, b, c].map((dir) => loadCqlMigrations([{ dir }])[0]?.checksum);
    expect(mb).toBe(ma);
    expect(mc).not.toBe(ma);
  });

  it.each([
    [
      'a misnamed file',
      { 'create.cql': 'SELECT 1;' },
      /Invalid CQL migration file name "create.cql"/,
    ],
    [
      'a duplicate number',
      { '1_a.cql': 'SELECT 1;', '001_b.cql': 'SELECT 1;' },
      /Duplicate CQL migration numbers .*: 1/,
    ],
    ['an empty file', { '001_empty.cql': '-- nothing here\n' }, /contains no statements/],
  ])('rejects %s', (_label, files, error) => {
    const dir = folder(root, 'bad', files);
    expect(() => loadCqlMigrations([{ dir }])).toThrow(error);
  });

  it('rejects the same version in two folders', () => {
    const a = folder(root, 'a', { '001_init.cql': 'SELECT 1;' });
    const b = folder(root, 'b', { '001_init.cql': 'SELECT 2;' });
    expect(() => loadCqlMigrations([{ dir: a }, { dir: b }])).toThrow(
      /Duplicate CQL migration versions: 001_init/,
    );
  });
});

describe('CqlMigrator.run', () => {
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cql-migrator-'));
    dir = folder(root, 'notifications', {
      '001_create.cql': 'CREATE TABLE IF NOT EXISTS {keyspace}.n (id uuid PRIMARY KEY);',
      '002_index.cql':
        'CREATE INDEX IF NOT EXISTS n_idx ON n (id);\nALTER TABLE n ADD read boolean;',
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const migrator = (store: ReturnType<typeof migrationsStore>, logger = silentLogger()) =>
    new CqlMigrator(store.client, {
      keyspace: 'app',
      sources: [{ dir }],
      logger,
      instanceId: 'test:1',
      pollIntervalMs: 5,
      lockTimeoutMs: 100,
    });

  it('applies pending migrations in order, claimed by LWT, with {keyspace} substituted', async () => {
    const store = migrationsStore();
    await expect(migrator(store).run()).resolves.toEqual({
      total: 2,
      applied: ['001_create', '002_index'],
    });
    expect(store.ddl).toEqual([
      'CREATE TABLE IF NOT EXISTS app.n (id uuid PRIMARY KEY)',
      'CREATE INDEX IF NOT EXISTS n_idx ON n (id)',
      'ALTER TABLE n ADD read boolean',
    ]);
    expect([...store.rows.values()].map((r) => [r.version, r.status, r.claimed_by])).toEqual([
      ['001_create', 'applied', 'test:1'],
      ['002_index', 'applied', 'test:1'],
    ]);
    const claim = store.executed.find(
      (q) => q.query.includes('IF NOT EXISTS') && q.query.startsWith('INSERT'),
    );
    expect(claim?.options).toMatchObject({ prepare: true });
    // DDL is never prepared.
    const ddlCall = store.executed.find((q) => q.query.startsWith('ALTER TABLE'));
    expect(ddlCall?.options).toMatchObject({ prepare: false });
  });

  it('is idempotent: a second run applies nothing and issues no LWT', async () => {
    const store = migrationsStore();
    await migrator(store).run();
    store.execute.mockClear();
    await expect(migrator(store).run()).resolves.toEqual({ total: 2, applied: [] });
    expect(store.execute.mock.calls.map(([query]) => query.split(' ')[0])).toEqual([
      'CREATE',
      'SELECT',
    ]);
  });

  it('warns (but does not re-run) when an applied migration was edited', async () => {
    const store = migrationsStore();
    await migrator(store).run();
    writeFileSync(
      join(dir, '001_create.cql'),
      'CREATE TABLE IF NOT EXISTS {keyspace}.n (id int PRIMARY KEY);',
    );
    const logger = silentLogger();
    await migrator(store, logger).run();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('001_create changed after it was applied'),
    );
    expect(store.ddl).toHaveLength(3);
  });

  it('waits for another instance that holds the claim instead of applying twice', async () => {
    const store = migrationsStore();
    store.rows.set('001_create', {
      version: '001_create',
      checksum: 'x',
      status: 'applying',
      claimed_by: 'other:9',
    });
    // The other instance finishes shortly after we start waiting.
    setTimeout(() => {
      const row = store.rows.get('001_create');
      if (row) row.status = 'applied';
    }, 20);
    const result = await migrator(store).run();
    expect(result.applied).toEqual(['002_index']);
    expect(store.ddl).not.toContain('CREATE TABLE IF NOT EXISTS app.n (id uuid PRIMARY KEY)');
  });

  it('gives up after lockTimeoutMs with instructions to release a stale claim', async () => {
    const store = migrationsStore();
    store.rows.set('001_create', {
      version: '001_create',
      checksum: 'x',
      status: 'applying',
      claimed_by: 'dead:1',
    });
    await expect(migrator(store).run()).rejects.toThrow(
      /Timed out after 100ms waiting for CQL migration 001_create \(claimed by dead:1\).*DELETE FROM app\.schema_migrations WHERE version = '001_create'/s,
    );
  });

  it('releases its claim and stops when a statement fails', async () => {
    const store = migrationsStore({ failOn: /^ALTER TABLE/ });
    await expect(migrator(store).run()).rejects.toThrow(/CQL migration 002_index failed/);
    expect(store.rows.get('001_create')?.status).toBe('applied');
    expect(store.rows.has('002_index')).toBe(false); // released → a retry can claim it again
  });

  it('validates the keyspace before building any CQL', () => {
    const store = migrationsStore();
    expect(() => new CqlMigrator(store.client, { keyspace: 'app; DROP', sources: [] })).toThrow(
      /Invalid CQL keyspace/,
    );
  });

  it('does not touch the cluster when there are no migrations', async () => {
    const store = migrationsStore();
    const empty = folder(root, 'empty', {});
    const result = await new CqlMigrator(store.client, {
      keyspace: 'app',
      sources: [{ dir: empty }],
    }).run();
    expect(result).toEqual({ total: 0, applied: [] });
    expect(store.execute).not.toHaveBeenCalled();
  });
});
