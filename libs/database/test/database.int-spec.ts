import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type INestApplicationContext, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transactional, TransactionHost } from '@nestjs-cls/transactional';
import { createPrincipal, generateId, isUuidV7, runWithPrincipal, sleep } from '@platform/common';
import { AppConfigModule } from '@platform/config';
import { readRolesInitSql, startTestPostgres, type TestPostgres } from '@platform/testing/postgres';
import { and, eq, sql } from 'drizzle-orm';
import { noop, sumBy } from 'lodash-es';
import { ClsModule } from 'nestjs-cls';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  DatabaseHealthIndicator,
  type DatabaseMigrationSet,
  DatabaseModule,
  DRIZZLE,
  type DrizzleDB,
  type DrizzleTransactionalAdapter,
  keysetFetchLimit,
  keysetOrder,
  keysetPage,
  keysetWhere,
  MIGRATIONS_ADVISORY_LOCK_ID,
  platformMigrations,
  runMigrations,
} from '../src/index.js';
import {
  anchoredAt0000,
  anchoredMigrations,
  gadgetsMigrations,
  gizmosMigrations,
  gizmosTablesMigrations,
  gizmosWithOnline,
  lockWaitMigrations,
  widgetsMigrations,
} from './fixtures/fixture-sets.js';
import { type NewWidget, type Widget, widgets } from './fixtures/widgets.schema.js';

/*
 * Real Postgres 18 (uuidv7() is PG18-native) with Citus 14.2, via @platform/testing/postgres. The
 * databases this spec creates have no citus extension, so they behave as plain Postgres. Opt-in:
 *   INTEGRATION=1 bunx vitest run --project database:int
 */
const PACKAGE_ROOT = join(import.meta.dirname, '..');
const schema = { widgets };
type Adapter = DrizzleTransactionalAdapter<typeof schema>;

const execFileAsync = promisify(execFile);
const silent = { log: noop, warn: noop, error: noop, debug: noop };
/** Every runtime transaction opens with the principal's RLS context (Task 5): run as one. */
const principal = createPrincipal({ userId: generateId(), tenantId: generateId() });
const asPrincipal = <T>(fn: () => T): T => runWithPrincipal(principal, fn);

@Injectable()
class WidgetsRepository {
  constructor(private readonly txHost: TransactionHost<Adapter>) {}

  async insert(row: NewWidget): Promise<Widget> {
    const [created] = await this.txHost.tx.insert(widgets).values(row).returning();
    if (created === undefined) throw new Error('insert returned no row');
    return created;
  }

  countFor(ownerId: string): Promise<number> {
    return this.txHost.tx.$count(widgets, eq(widgets.ownerId, ownerId));
  }

  async page(ownerId: string, limit: number, cursor?: string | null) {
    const rows = await this.txHost.tx
      .select()
      .from(widgets)
      .where(and(eq(widgets.ownerId, ownerId), keysetWhere(widgets.id, cursor)))
      .orderBy(keysetOrder(widgets.id))
      .limit(keysetFetchLimit(limit));
    return keysetPage(rows, limit);
  }
}

@Injectable()
class WidgetsService {
  constructor(
    private readonly repo: WidgetsRepository,
    private readonly txHost: TransactionHost<Adapter>,
  ) {}

  /** All-or-nothing: throws after `failAfter` inserts when given. */
  @Transactional()
  async createMany(ownerId: string, names: string[], failAfter?: number): Promise<void> {
    for (const [index, name] of names.entries()) {
      if (index === failAfter) throw new Error('business rule violated');
      await this.repo.insert({ ownerId, name });
    }
  }

  isolationInsideSerializable(): Promise<string | undefined> {
    return this.txHost.withTransaction({ isolationLevel: 'serializable' }, async () => {
      const rows = await this.txHost.tx.execute<{ transaction_isolation: string }>(
        sql`show transaction_isolation`,
      );
      return rows[0]?.transaction_isolation;
    });
  }
}

describe('@platform/database against PostgreSQL 18', () => {
  let pg: TestPostgres;
  let admin: Sql;
  const urlFor = (database: string): string => {
    const url = new URL(pg.url);
    url.pathname = `/${database}`;
    return url.toString();
  };
  const createDatabase = async (name: string): Promise<string> => {
    await admin.unsafe(`create database ${name}`);
    return urlFor(name);
  };
  const migrationRows = async (url: string, set: DatabaseMigrationSet): Promise<number> => {
    const client = postgres(url, { max: 1, onnotice: noop });
    try {
      const [row] = await client<{ count: number }[]>`
        select count(*)::int as count
        from ${client(set.migrationsSchema)}.${client(set.migrationsTable)}`;
      return row?.count ?? -1;
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    // Never INTEGRATION_DATABASE_URL: this spec creates databases (race, sets, …) on the server.
    // Roles are per server: every database created below can run the platform set's 0002 grants.
    pg = await startTestPostgres({ allowExternalUrl: false, initSql: readRolesInitSql() });
    admin = postgres(pg.url, { max: 1, onnotice: noop });
  });

  afterAll(async () => {
    await admin?.end({ timeout: 5 });
    await pg?.stop();
  });

  describe('runMigrations()', () => {
    it('applies each migration exactly once when replicas race, then releases the lock', async () => {
      const url = await createDatabase('race');
      const migrations = [platformMigrations, widgetsMigrations, gadgetsMigrations];
      const runs = await Promise.all(
        [1, 2, 3].map(() =>
          runMigrations(url, { migrations, lockPollIntervalMs: 50, logger: silent }),
        ),
      );
      expect(sumBy(runs, 'applied')).toBe(6);
      expect(runs.every((run) => run.total === 6)).toBe(true);
      expect(await migrationRows(url, widgetsMigrations)).toBe(2);
      const [locks] = await admin<{ count: number }[]>`
        select count(*)::int as count from pg_locks
        where locktype = 'advisory' and objid = ${MIGRATIONS_ADVISORY_LOCK_ID}`;
      expect(locks?.count).toBe(0);

      const rerun = await runMigrations(url, { migrations, logger: silent });
      expect(rerun).toMatchObject({ applied: 0, total: 6 });
    });

    it('gives each set its own bookkeeping table, so a set with OLDER timestamps still applies', async () => {
      const url = await createDatabase('sets');
      const summary = await runMigrations(url, {
        migrations: [platformMigrations, widgetsMigrations, gadgetsMigrations],
        logger: silent,
      });
      expect(summary.sets.map(({ name, applied }) => ({ name, applied }))).toEqual([
        { name: 'platform', applied: 3 },
        { name: 'widgets', applied: 2 },
        { name: 'gadgets', applied: 1 },
      ]);
      expect(await migrationRows(url, widgetsMigrations)).toBe(2);
      expect(await migrationRows(url, gadgetsMigrations)).toBe(1);
    });

    it('refuses a database whose history predates the set baseline (a squashed set), naming the fix', async () => {
      const url = await createDatabase('pre_squash');
      const migrations = [platformMigrations, widgetsMigrations];
      await runMigrations(url, { migrations, logger: silent });
      // Rewrite widgets' bookkeeping as if the database had stopped part-way through an older,
      // since-squashed history: its latest applied migration is older than the set's first one.
      const client = postgres(url, { max: 1, onnotice: noop });
      try {
        const table = client`${client(widgetsMigrations.migrationsSchema)}.${client(widgetsMigrations.migrationsTable)}`;
        await client`delete from ${table} where id <> (select min(id) from ${table})`;
        await client`update ${table} set created_at = 1`;
      } finally {
        await client.end();
      }
      const error: unknown = await runMigrations(url, { migrations, logger: silent }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).cause)).toMatch(
        /widgets.*older than the set's first migration.*recreate/is,
      );
    });

    it('counts what it applied when the bookkeeping schema is mixed-case', async () => {
      const url = await createDatabase('mixed_case');
      const mixed: DatabaseMigrationSet = {
        ...gadgetsMigrations,
        name: 'MixedCase',
        migrationsSchema: 'MixedCase_Bookkeeping',
      };
      const online = { total: 0, applied: 0 }; // no online steps
      await expect(
        runMigrations(url, { migrations: [platformMigrations, mixed], logger: silent }),
      ).resolves.toEqual({
        sets: [
          { name: 'platform', folder: platformMigrations.folder, total: 3, applied: 3, online },
          { name: 'MixedCase', folder: mixed.folder, total: 1, applied: 1, online },
        ],
        total: 4,
        applied: 4,
        online,
      });
      expect(await migrationRows(url, mixed)).toBe(1);
      await expect(
        runMigrations(url, { migrations: [platformMigrations, mixed], logger: silent }),
      ).resolves.toMatchObject({ total: 4, applied: 0 });
    });
  });

  describe('runMigrations() lock waits (OPS-2)', () => {
    /** The base sets, then the one whose ALTER needs ACCESS EXCLUSIVE on widgets. */
    const withLockWait = [platformMigrations, widgetsMigrations, lockWaitMigrations];

    /** A database at widgets' tip, so only lockWaitMigrations is pending. */
    const widgetsDatabase = async (name: string): Promise<string> => {
      const url = await createDatabase(name);
      await runMigrations(url, {
        migrations: [platformMigrations, widgetsMigrations],
        logger: silent,
      });
      return url;
    };

    /**
     * A second connection holding ACCESS SHARE on widgets inside an open transaction (what a
     * reporting query or pg_dump does). `commit` ends it; it is also committed when the test ends,
     * even on a timeout, so an ALTER still queued behind it can finish before afterAll.
     */
    const holdAccessShare = async (url: string) => {
      const client = postgres(url, { max: 1, onnotice: noop });
      const conn = await client.reserve();
      await conn`begin`;
      await conn`select 1 from widgets limit 1`;
      let open = true;
      const commit = async (): Promise<void> => {
        if (!open) return;
        open = false;
        await conn`commit`;
        conn.release();
      };
      onTestFinished(async () => {
        await commit().catch(noop);
        await client.end({ timeout: 5 });
      });
      return { commit };
    };

    const hasNoteColumn = async (url: string): Promise<boolean> => {
      const client = postgres(url, { max: 1, onnotice: noop });
      try {
        const [row] = await client<{ present: boolean }[]>`
          select exists (
            select 1 from information_schema.columns
            where table_name = 'widgets' and column_name = 'note'
          ) as present`;
        return row?.present === true;
      } finally {
        await client.end();
      }
    };

    it('gives up on a set blocked by an open transaction within seconds: names the set, 55P03 as cause, no row', async () => {
      const url = await widgetsDatabase('lock_wait_gives_up');
      await holdAccessShare(url);

      const started = Date.now();
      const error: unknown = await runMigrations(url, {
        migrations: withLockWait,
        logger: silent,
        lockWaitTimeoutMs: 500,
        lockWaitRetries: 1,
        lockWaitRetryDelayMs: 200,
      }).catch((caught: unknown) => caught);

      expect(Date.now() - started).toBeLessThan(5_000);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(
        /^Migration set "lock-wait" .* failed: lock_timeout \(500ms\) expired on all 2 attempts/,
      );
      expect((error as Error).cause).toMatchObject({ code: '55P03' });
      expect(await migrationRows(url, lockWaitMigrations)).toBe(0);
      expect(await hasNoteColumn(url)).toBe(false);
    }, 20_000);

    it('retries after a lock timeout and applies the set once when the blocker commits during the backoff', async () => {
      const url = await widgetsDatabase('lock_wait_retries');
      const blocker = await holdAccessShare(url);
      const warnings: string[] = [];

      const summary = await runMigrations(url, {
        migrations: withLockWait,
        logger: {
          ...silent,
          warn: (message: unknown) => {
            warnings.push(String(message));
            // The first attempt timed out: end the blocking transaction during the backoff.
            void blocker.commit();
          },
        },
        lockWaitTimeoutMs: 500,
        lockWaitRetries: 1,
        lockWaitRetryDelayMs: 1_000,
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(
        /^lock-wait: lock_timeout \(500ms\) expired \(55P03\); retry 1 of 1/,
      );
      expect(summary.sets.at(-1)).toMatchObject({ name: 'lock-wait', applied: 1 });
      expect(await migrationRows(url, lockWaitMigrations)).toBe(1);
      expect(await hasNoteColumn(url)).toBe(true);
    }, 20_000);
  });

  describe('runMigrations() online steps (OPS-2)', () => {
    const TENANT = '0190a0a0-0000-7000-8000-000000000001';

    /** Runs `fn` on a short-lived superuser connection to `url`. */
    const withClient = async <T>(url: string, fn: (client: Sql) => Promise<T>): Promise<T> => {
      const client = postgres(url, { max: 1, onnotice: noop });
      try {
        return await fn(client);
      } finally {
        await client.end();
      }
    };

    /** `gizmos.<name>`'s validity, or `undefined` when there is no such index. */
    const indexValid = (url: string, name: string): Promise<boolean | undefined> =>
      withClient(url, async (client) => {
        const [row] = await client<{ valid: boolean }[]>`
          select i.indisvalid as valid from pg_index i
          join pg_class c on c.oid = i.indexrelid
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'gizmos' and c.relname = ${name}`;
        return row?.valid;
      });

    /** The online steps recorded for the gizmos set; `null` before its bookkeeping table exists. */
    const recorded = (url: string): Promise<string[] | null> =>
      withClient(url, async (client) => {
        const [table] = await client<{ exists: boolean }[]>`
          select to_regclass('gizmos.__online_migrations') is not null as exists`;
        if (table?.exists !== true) return null;
        const rows = await client<{ name: string }[]>`
          select name from gizmos.__online_migrations order by name`;
        return rows.map((row) => row.name);
      });

    const insertGizmos = (url: string, rows: { id: number; code: string }[]): Promise<void> =>
      withClient(url, async (client) => {
        for (const { id, code } of rows) {
          await client`
            insert into gizmos.gizmos (tenant_id, id, name, code)
            values (${TENANT}, ${id}, ${`gizmo ${id}`}, ${code})`;
        }
      });

    it('applies an online file once, outside the transaction, records it; a second run applies 0', async () => {
      const url = await createDatabase('online_once');
      const migrations = [platformMigrations, gizmosMigrations];

      const first = await runMigrations(url, { migrations, logger: silent });

      expect(first.sets.at(-1)).toMatchObject({
        name: 'gizmos',
        applied: 1,
        online: { total: 1, applied: 1 },
      });
      expect(first.online).toEqual({ total: 1, applied: 1 });
      expect(await recorded(url)).toEqual(['0000_gizmos_name_idx.sql']);
      expect(await indexValid(url, 'gizmos_name_idx')).toBe(true);

      const second = await runMigrations(url, { migrations, logger: silent });
      expect(second).toMatchObject({ applied: 0, online: { total: 1, applied: 0 } });
      expect(await recorded(url)).toEqual(['0000_gizmos_name_idx.sql']);
    });

    it('waits for a writer although the set timeout is 500 ms: the online session has its own lock_timeout (0)', async () => {
      const url = await createDatabase('online_waits');
      await runMigrations(url, {
        migrations: [platformMigrations, gizmosTablesMigrations],
        logger: silent,
      });
      // A transaction that wrote to gizmos, open for 3 s: a concurrent build waits for it, which
      // the sets' 500 ms lock_timeout would cut short (55P03, and an invalid index left behind).
      const writer = postgres(url, { max: 1, onnotice: noop });
      const conn = await writer.reserve();
      await conn`begin`;
      await conn`
        insert into gizmos.gizmos (tenant_id, id, name, code) values (${TENANT}, 1, 'held', 'h')`;
      const released = (async () => {
        await sleep(3_000);
        await conn`commit`;
        conn.release();
      })();
      onTestFinished(async () => {
        await released.catch(noop);
        await writer.end({ timeout: 5 });
      });

      const started = Date.now();
      const summary = await runMigrations(url, {
        migrations: [platformMigrations, gizmosMigrations],
        logger: silent,
        lockWaitTimeoutMs: 500,
      });

      expect(summary.online).toEqual({ total: 1, applied: 1 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
      expect(await indexValid(url, 'gizmos_name_idx')).toBe(true);
    }, 30_000);

    it('a failing file records nothing and fails the run naming it; the next run drops the invalid index it left and retries it', async () => {
      const url = await createDatabase('online_retry');
      await runMigrations(url, {
        migrations: [platformMigrations, gizmosTablesMigrations],
        logger: silent,
      });
      // Two rows of one tenant share a code: the unique build fails part-way.
      await insertGizmos(url, [
        { id: 1, code: 'dup' },
        { id: 2, code: 'dup' },
      ]);
      const migrations = [platformMigrations, gizmosWithOnline('online-retry')];

      const error: unknown = await runMigrations(url, { migrations, logger: silent }).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(
        /^Migration set "gizmos": online step 0000_gizmos_code_key\.sql \(.*\) failed; nothing was recorded for it/,
      );
      expect((error as Error).cause).toMatchObject({ code: '23505' });
      expect(await recorded(url)).toEqual([]);
      // What a plain rerun of `IF NOT EXISTS` would then skip silently.
      expect(await indexValid(url, 'gizmos_code_key')).toBe(false);

      await withClient(url, (client) => client`delete from gizmos.gizmos where id = 2`);
      const retry = await runMigrations(url, { migrations, logger: silent });

      expect(retry.online).toEqual({ total: 1, applied: 1 });
      expect(await recorded(url)).toEqual(['0000_gizmos_code_key.sql']);
      expect(await indexValid(url, 'gizmos_code_key')).toBe(true);
    });

    it('refuses a file holding two statements: neither runs, nothing is recorded', async () => {
      const url = await createDatabase('online_two');
      const error: unknown = await runMigrations(url, {
        migrations: [platformMigrations, gizmosWithOnline('online-two-statements')],
        logger: silent,
      }).catch((caught: unknown) => caught);

      expect((error as Error).message).toMatch(/online step 0000_two_indexes\.sql/);
      expect((error as Error).cause).toMatchObject({ code: '42601' });
      expect(await recorded(url)).toEqual([]);
      expect(await indexValid(url, 'gizmos_name_idx')).toBeUndefined();
      expect(await indexValid(url, 'gizmos_code_idx')).toBeUndefined();
    });

    describe('at their place in the history (review #4)', () => {
      /** The `anchored` table's key constraints, by name and type (`p` primary, `u` unique). */
      const anchoredConstraints = (url: string): Promise<string[]> =>
        withClient(url, async (client) => {
          const rows = await client<{ constraint: string }[]>`
            select conname || ':' || contype::text as constraint from pg_constraint
            where conrelid = to_regclass('anchored.anchored') and contype in ('p', 'u')
            order by conname`;
          return rows.map((row) => row.constraint);
        });

      /** The anchored set's online steps recorded so far. */
      const anchoredRecorded = (url: string): Promise<string[]> =>
        withClient(url, async (client) => {
          const rows = await client<{ name: string }[]>`
            select name from anchored.__online_migrations order by name`;
          return rows.map((row) => row.name);
        });

      it('a fresh database runs the step anchored at 0000 before 0001, which needs its index', async () => {
        const url = await createDatabase('anchored_fresh');

        const summary = await runMigrations(url, {
          migrations: [platformMigrations, anchoredMigrations],
          logger: silent,
        });

        expect(summary.sets.at(-1)).toMatchObject({
          name: 'anchored',
          total: 2,
          applied: 2,
          online: { total: 1, applied: 1 },
        });
        expect(await anchoredConstraints(url)).toEqual(['anchored_code_key:u', 'anchored_pkey:p']);
        expect(await anchoredRecorded(url)).toEqual(['0000_anchored_code_key.sql']);
        expect(await migrationRows(url, anchoredMigrations)).toBe(2);
        await expect(
          runMigrations(url, {
            migrations: [platformMigrations, anchoredMigrations],
            logger: silent,
          }),
        ).resolves.toMatchObject({ applied: 0, online: { total: 1, applied: 0 } });
      });

      it('a database at 0000 with the step applied applies 0001 alone', async () => {
        const url = await createDatabase('anchored_existing');
        const before = await runMigrations(url, {
          migrations: [platformMigrations, anchoredAt0000],
          logger: silent,
        });
        expect(before.sets.at(-1)).toMatchObject({ applied: 1, online: { total: 1, applied: 1 } });
        expect(await anchoredConstraints(url)).toEqual(['anchored_pkey:p']);

        const summary = await runMigrations(url, {
          migrations: [platformMigrations, anchoredMigrations],
          logger: silent,
        });

        expect(summary.sets.at(-1)).toMatchObject({
          total: 2,
          applied: 1,
          online: { total: 1, applied: 0 },
        });
        expect(await anchoredConstraints(url)).toEqual(['anchored_code_key:u', 'anchored_pkey:p']);
        expect(await migrationRows(url, anchoredMigrations)).toBe(2);
      });
    });

    it('on Citus, builds the index on every shard of a distributed table and waits for a writer although the set timeout is 500 ms; the role default is back at 500 ms afterwards', async () => {
      const url = pg.url; // database `app`: the citus extension
      onTestFinished(async () => {
        // The runner leaves the role default at the set timeout (500 ms here): give the superuser
        // back its unset default before later tests open connections as it.
        await admin`alter role current_user reset lock_timeout`;
      });
      await runMigrations(url, {
        migrations: [platformMigrations, gizmosTablesMigrations],
        logger: silent,
        lockWaitTimeoutMs: 500,
      });
      const [distributed] = await withClient(
        url,
        (client) => client<{ shards: number }[]>`
          select count(*)::int as shards from pg_dist_shard
          where logicalrelid = 'gizmos.gizmos'::regclass`,
      );
      expect(distributed?.shards).toBe(4);

      // A writer's lock on ONE shard, held for 3 s: only the shard connections Citus opens for the
      // build meet it, and they start from the role's default (500 ms here), not from the online
      // session's lock_timeout. (A write through the coordinator would first hold up the build on
      // the shell table, where the session's own setting applies, and end before the shards.)
      const writer = postgres(url, { max: 1, onnotice: noop });
      const conn = await writer.reserve();
      await conn`begin`;
      const [shard] = await conn<{ name: string }[]>`
        select shard_name as name from citus_shards
        where table_name = 'gizmos.gizmos'::regclass order by shardid limit 1`;
      await conn.unsafe(`lock table ${shard?.name ?? 'missing'} in row exclusive mode`);
      const released = (async () => {
        await sleep(3_000);
        await conn`commit`;
        conn.release();
      })();
      onTestFinished(async () => {
        await released.catch(noop);
        await writer.end({ timeout: 5 });
      });

      const started = Date.now();
      const summary = await runMigrations(url, {
        migrations: [platformMigrations, gizmosMigrations],
        logger: silent,
        lockWaitTimeoutMs: 500,
      });
      const waitedMs = Date.now() - started;

      expect(summary.online).toEqual({ total: 1, applied: 1 });
      expect(waitedMs).toBeGreaterThanOrEqual(2_000);
      expect(await indexValid(url, 'gizmos_name_idx')).toBe(true);
      const shardIndexes = await withClient(url, async (client) => {
        await client`set citus.override_table_visibility to off`; // shards are hidden otherwise
        return client<{ valid: boolean }[]>`
          select i.indisvalid as valid from pg_index i
          join pg_class c on c.oid = i.indexrelid
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'gizmos' and c.relname like 'gizmos\\_name\\_idx\\_%'`;
      });
      expect(shardIndexes.map((row) => row.valid)).toEqual([true, true, true, true]);
      const [role] = await admin<{ setconfig: string[] | null }[]>`
        select setconfig from pg_db_role_setting
        where setdatabase = 0 and setrole = (select oid from pg_roles where rolname = current_user)`;
      expect(role?.setconfig).toContain('lock_timeout=500');
    }, 60_000);

    it('on Citus, a per-database lock_timeout of the migration role (which takes precedence) ends at the configured value', async () => {
      const url = pg.url; // database `app`: the citus extension
      onTestFinished(async () => {
        await admin`alter role current_user in database app reset lock_timeout`;
        await admin`alter role current_user reset lock_timeout`;
      });
      await admin`alter role current_user in database app set lock_timeout = 0`;

      await runMigrations(url, {
        migrations: [platformMigrations],
        logger: silent,
        lockWaitTimeoutMs: 700,
      });

      // A new connection without a lock_timeout startup parameter starts from the role's settings,
      // as the worker connections Citus opens do: the per-database one wins over the role-wide one.
      const [effective] = await withClient(
        url,
        (client) => client<{ lock_timeout: string }[]>`show lock_timeout`,
      );
      expect(effective?.lock_timeout).toBe('700ms');
      const [perDatabase] = await admin<{ setconfig: string[] | null }[]>`
        select setconfig from pg_db_role_setting
        where setdatabase = (select oid from pg_database where datname = 'app')
          and setrole = (select oid from pg_roles where rolname = current_user)`;
      expect(perDatabase?.setconfig).toContain('lock_timeout=700');
    }, 60_000);
  });

  describe("runMigrationsCli() (the body of every app's migrate.ts)", () => {
    /** A closed port: the migrate job must never connect to DATABASE_URL. */
    const UNREACHABLE = 'postgres://app:app@127.0.0.1:1/app';
    const cliWith = (env: Record<string, string>, ...args: string[]) =>
      execFileAsync(
        process.execPath,
        [
          '--conditions=@repo/source',
          '--import',
          '@swc-node/register/esm-register',
          'test/fixtures/migrate.ts',
          ...args,
        ],
        {
          cwd: PACKAGE_ROOT,
          env: { ...process.env, DATABASE_URL: UNREACHABLE, ...env },
          timeout: 90_000,
        },
      );

    const cli = (migrationUrl: string, ...args: string[]) =>
      cliWith({ DATABASE_MIGRATION_URL: migrationUrl }, ...args);

    it('applies the platform set, then the given sets, and exits 0; a second run is a no-op', async () => {
      const url = await createDatabase('cli');
      const first = await cli(url);
      expect(first.stdout).toContain('Done: 6 applied, 6 total (platform, widgets, gadgets)');
      const second = await cli(url);
      expect(second.stdout).toContain('Done: 0 applied, 6 total (platform, widgets, gadgets)');
      expect(await migrationRows(url, platformMigrations)).toBe(3);
      expect(await migrationRows(url, widgetsMigrations)).toBe(2);
    });

    it('exits 1 on an unknown flag (the removed --migrations-folder)', async () => {
      await expect(cli(UNREACHABLE, '--migrations-folder', 'x')).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('--migrations-folder') as unknown,
      });
    });

    it('exits 1 with the config error for an invalid DATABASE_URL', async () => {
      await expect(
        cliWith({ DATABASE_URL: 'mysql://nope', DATABASE_MIGRATION_URL: UNREACHABLE }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('DATABASE_URL') as unknown,
      });
    });

    it('exits 1 with the config error for an invalid DATABASE_MIGRATION_URL', async () => {
      await expect(cli('mysql://nope')).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('DATABASE_MIGRATION_URL') as unknown,
      });
    });

    it('exits 1 naming DATABASE_MIGRATION_URL when it is empty (no DATABASE_URL fallback)', async () => {
      await expect(cli('')).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('DATABASE_MIGRATION_URL is not set') as unknown,
      });
    });
  });

  describe('DatabaseModule (booted Nest application context)', () => {
    let app: INestApplicationContext;
    let db: DrizzleDB<typeof schema>;
    let service: WidgetsService;
    let repo: WidgetsRepository;

    beforeAll(async () => {
      const bootUrl = await createDatabase('boot');
      vi.stubEnv('DATABASE_URL', bootUrl);
      vi.stubEnv('DATABASE_MIGRATION_URL', bootUrl);
      vi.stubEnv('SERVICE_NAME', 'db-int');

      @Module({
        imports: [
          AppConfigModule.forRoot(),
          ClsModule.forRoot({ global: true }),
          // The platform set runs first and creates schema `app`. Connected as role `app`, the
          // default search_path ("$user", public) then starts with `app`, so the unqualified
          // widgets table lands there; every query below is unqualified too.
          DatabaseModule.forRootAsync({
            schema,
            runMigrations: true,
            migrations: [widgetsMigrations],
          }),
        ],
        providers: [WidgetsRepository, WidgetsService],
      })
      class IntegrationModule {}

      app = await NestFactory.createApplicationContext(IntegrationModule, { logger: false });
      db = app.get(DRIZZLE);
      service = app.get(WidgetsService);
      repo = app.get(WidgetsRepository);
    });

    afterAll(async () => {
      await app?.close();
      vi.unstubAllEnvs();
    });

    it('applied the migrations at boot, before the pool served queries', async () => {
      const rows = await db.execute<{ column_name: string }>(sql`
        select column_name from information_schema.columns
        where table_name = 'widgets' order by ordinal_position`);
      expect(rows.map((row) => row.column_name)).toEqual([
        'id',
        'owner_id',
        'name',
        'quantity',
        'created_at',
        'sku',
      ]);
    });

    it('sends the startup GUCs (application_name, timeouts, UTC)', async () => {
      const [row] = await db.$client<Record<string, string>[]>`
        select current_setting('application_name') as app,
               current_setting('statement_timeout') as statement_timeout,
               current_setting('idle_in_transaction_session_timeout') as idle_tx,
               current_setting('TimeZone') as tz`;
      expect(row).toEqual({ app: 'db-int', statement_timeout: '15s', idle_tx: '1min', tz: 'UTC' });
    });

    it('generates uuidv7 ids in the database (PG18 default)', async () => {
      const [row] = await db.execute<{ id: string }>(sql`
        insert into widgets (owner_id, name) values (${generateId()}, 'db-default') returning id`);
      expect(isUuidV7(row?.id)).toBe(true);
    });

    it('@Transactional() commits all statements together', async () => {
      const ownerId = generateId();
      await asPrincipal(() => service.createMany(ownerId, ['a', 'b', 'c']));
      expect(await repo.countFor(ownerId)).toBe(3);
    });

    it('@Transactional() rolls back every statement when the method throws', async () => {
      const ownerId = generateId();
      await expect(
        asPrincipal(() => service.createMany(ownerId, ['x', 'y', 'z'], 2)),
      ).rejects.toThrow('business rule violated');
      expect(await repo.countFor(ownerId)).toBe(0);
    });

    it('applies per-call transaction options', async () => {
      await expect(asPrincipal(() => service.isolationInsideSerializable())).resolves.toBe(
        'serializable',
      );
    });

    it('why the adapter normalizes options: drizzle renders {} as an invalid SET TRANSACTION', async () => {
      // drizzle wraps it as "Failed query: set transaction"; the cause is 42601 syntax_error.
      await expect(db.transaction(async () => undefined, {})).rejects.toMatchObject({
        message: expect.stringContaining('set transaction') as unknown,
        cause: { code: '42601' },
      });
    });

    it('pages newest-first with uuidv7 keyset cursors until nextCursor is null', async () => {
      const ownerId = generateId();
      // App-side uuidv7 (monotonic within the process) → insertion order = id order.
      for (const name of ['w1', 'w2', 'w3', 'w4', 'w5']) {
        await repo.insert({ id: generateId(), ownerId, name });
      }
      const pages: string[][] = [];
      let cursor: string | null = null;
      do {
        const page = await repo.page(ownerId, 2, cursor);
        pages.push(page.items.map((item) => item.name));
        cursor = page.nextCursor;
      } while (cursor !== null);
      expect(pages).toEqual([['w5', 'w4'], ['w3', 'w2'], ['w1']]);
    });

    it('reports the pool healthy', async () => {
      await expect(app.get(DatabaseHealthIndicator).check()).resolves.toMatchObject({
        postgres: { status: 'up' },
      });
    });

    it('drains the pool on shutdown', async () => {
      await app.close();
      await expect(db.$client`select 1`).rejects.toThrow();
    });
  });
});
