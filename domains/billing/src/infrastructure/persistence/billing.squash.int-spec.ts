import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoggerService } from '@nestjs/common';
import {
  type DatabaseMigrationSet,
  runMigrations,
  withPlatformMigrations,
} from '@platform/database';
import {
  type RlsTestPostgres,
  readSchemaCatalog,
  type SchemaCatalog,
  startRlsTestPostgres,
} from '@platform/testing/postgres';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { billingMigrations } from './billing.migrations.js';

/*
 * The final squash (SH-12, program spec §2 "Final squash"): billing's stacked history, 0000_init ..
 * 0008_ledger_trusted_state_read_at, folded into one 0000_init. The stacked files are kept as a fixture
 * (test/stacked-history/migrations, the SQL and journal as they were at the squash). Each history
 * goes to its own fresh Citus 14.2 (single node, local execution off, the three roles) through the
 * real runner as app_owner, after the platform set, and the catalogs of `app` and `billing` must be
 * equal: tables, columns, constraints, indexes, policies, grants, enums, triggers and the Citus
 * distribution (kind, distribution column, colocation group, shard ranges). Only the journal's
 * first entry of the current folder is applied, so later migrations never change what this proves.
 * DOC-1: a database already at the stacked tip is upgraded in place. The stacked history goes to one
 * database, then the current set (baseline plus the files added after it) to the same database:
 * the baseline is skipped (it keeps the stacked tip's journal timestamp), only the later files
 * apply, and the pre-squash tables are unchanged. Only a database stopped part-way is refused.
 * Opt-in (needs Docker): INTEGRATION=1 bunx vitest run --project billing:int squash
 */

const silent: LoggerService = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const STACKED_FOLDER = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'test',
  'stacked-history',
  'migrations',
);
const SCHEMAS = ['app', 'billing'] as const;

interface Journal {
  entries: { idx: number; tag: string }[];
}

const readJournal = (folder: string): Journal =>
  JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as Journal;

/** The tables of the current set that the stacked history does not have (files after the baseline). */
const ADDED_AFTER_BASELINE = new Set(['billing.ledger_reanchors']);

/** `catalog` without the rows of the tables added after the baseline. */
const withoutAddedTables = (catalog: SchemaCatalog): SchemaCatalog =>
  Object.fromEntries(
    (Object.entries(catalog) as [string, Record<string, unknown>[]][]).map(([part, rows]) => [
      part,
      rows.filter((row) => !ADDED_AFTER_BASELINE.has(String(row['relation']))),
    ]),
  ) as unknown as SchemaCatalog;

/** A copy of `folder` holding only the journal's first entry (the squashed 0000_init). */
function baselineOnly(folder: string): string {
  const copy = mkdtempSync(join(tmpdir(), 'billing-squash-'));
  const journal = readJournal(folder);
  const [first] = journal.entries;
  if (first === undefined) throw new Error(`${folder} has an empty journal`);
  mkdirSync(join(copy, 'meta'));
  writeFileSync(
    join(copy, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: [first] }),
  );
  copyFileSync(join(folder, `${first.tag}.sql`), join(copy, `${first.tag}.sql`));
  return copy;
}

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'billing final squash (SH-12): 0000_init equals the stacked history on Citus',
  () => {
    const servers: RlsTestPostgres[] = [];
    let baseline: string | undefined;
    const applied: Record<'stacked' | 'squashed', number> = { stacked: -1, squashed: -1 };
    const catalogs: Partial<Record<'stacked' | 'squashed', SchemaCatalog>> = {};
    let upgrade: { applied: number; catalog: SchemaCatalog } | undefined;

    /** Applies the platform set and `folder` as billing's set, then reads the catalog. */
    const build = async (
      pg: RlsTestPostgres,
      folder: string,
    ): Promise<{ applied: number; catalog: SchemaCatalog }> => {
      const set: DatabaseMigrationSet = { ...billingMigrations, folder };
      const summary = await runMigrations(pg.migrationUrl, {
        migrations: withPlatformMigrations([set]),
        logger: silent,
        applicationName: 'billing-squash-int',
      });
      const admin = postgres(pg.url, { max: 1, onnotice: () => undefined });
      try {
        return {
          applied: summary.sets.find((entry) => entry.name === set.name)?.applied ?? -1,
          catalog: await readSchemaCatalog(admin, SCHEMAS),
        };
      } finally {
        await admin.end({ timeout: 5 });
      }
    };

    beforeAll(async () => {
      baseline = baselineOnly(billingMigrations.folder);
      const started = await Promise.allSettled([startRlsTestPostgres(), startRlsTestPostgres()]);
      for (const result of started) if (result.status === 'fulfilled') servers.push(result.value);
      const failed = started.find((result) => result.status === 'rejected');
      if (failed !== undefined) throw failed.reason;
      const [stacked, squashed] = servers as [RlsTestPostgres, RlsTestPostgres];
      const [old, fresh] = await Promise.all([
        build(stacked, STACKED_FOLDER),
        build(squashed, baseline),
      ]);
      applied.stacked = old.applied;
      applied.squashed = fresh.applied;
      catalogs.stacked = old.catalog;
      catalogs.squashed = fresh.catalog;
      // DOC-1: the database at the stacked tip, then the current set, through the same runner. The
      // stacked catalog above was read before this run, so it stays the reference.
      upgrade = await build(stacked, billingMigrations.folder);
    });

    afterAll(async () => {
      await Promise.allSettled(servers.map((pg) => pg.stop()));
      if (baseline !== undefined) rmSync(baseline, { recursive: true, force: true });
    });

    it('applies the nine stacked files to one database and the single 0000_init to the other', () => {
      expect(readJournal(STACKED_FOLDER).entries.map((entry) => entry.tag)).toHaveLength(9);
      expect(applied).toEqual({ stacked: 9, squashed: 1 });
    });

    it('builds a non-trivial billing schema: eight tables, six distributed, with RLS and grants', () => {
      const catalog = catalogs.stacked;
      expect(
        catalog?.relations
          .filter((row) => String(row['relation']).startsWith('billing.'))
          .map((row) => row['relation']),
      ).toEqual([
        'billing.__drizzle_migrations',
        'billing.__drizzle_migrations_id_seq',
        'billing.ledger_accounts',
        'billing.ledger_discrepancies',
        'billing.ledger_entry_refs',
        'billing.ledger_reconciliation_runs',
        'billing.ledger_trusted_state',
        'billing.outbox',
        'billing.payments',
        'billing.stripe_events',
      ]);
      expect(catalog?.distribution.map((row) => row['relation'])).toEqual([
        'app.tenant_colocation',
        'billing.ledger_accounts',
        'billing.ledger_discrepancies',
        'billing.ledger_entry_refs',
        'billing.outbox',
        'billing.payments',
        'billing.stripe_events',
      ]);
      expect(catalog?.policies.length).toBeGreaterThan(10);
      expect(catalog?.tableGrants.length).toBeGreaterThan(20);
      expect(catalog?.enums).toHaveLength(1);
    });

    it.each([
      'schemas',
      'relations',
      'columns',
      'constraints',
      'indexes',
      'policies',
      'tableGrants',
      'columnGrants',
      'enums',
      'functions',
      'triggers',
      'distribution',
    ] as const)('has the same %s', (part) => {
      expect(catalogs.squashed?.[part]).toEqual(catalogs.stacked?.[part]);
    });

    it('upgrades a database at the stacked tip in place: skips 0000_init, applies only the later files', () => {
      const [, ...afterBaseline] = readJournal(billingMigrations.folder).entries;
      expect(afterBaseline.map((entry) => entry.tag)).toEqual(['0001_ledger_reanchors']);
      expect(upgrade?.applied).toBe(afterBaseline.length);
      expect(
        upgrade?.catalog.relations.some((row) => row['relation'] === 'billing.ledger_reanchors'),
      ).toBe(true);
    });

    it.each([
      'schemas',
      'relations',
      'columns',
      'constraints',
      'indexes',
      'policies',
      'tableGrants',
      'columnGrants',
      'enums',
      'functions',
      'triggers',
      'distribution',
    ] as const)('keeps the %s of the pre-squash tables unchanged by the upgrade', (part) => {
      expect(upgrade && withoutAddedTables(upgrade.catalog)[part]).toEqual(
        catalogs.stacked?.[part],
      );
    });
  },
);
