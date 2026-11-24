import { sleep } from '@platform/common';
import {
  readRolesInitSql,
  startTestPostgres,
  type TestPostgres,
  testPostgresWorkerAlias,
} from '@platform/testing/postgres';
import { noop } from 'lodash-es';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { type DatabaseMigrationSet, platformMigrations, runMigrations } from '../src/index.js';
import {
  gizmosLockWaitMigrations,
  gizmosMigrations,
  gizmosTablesMigrations,
  gizmosWithOnline,
} from './fixtures/fixture-sets.js';

/*
 * Lock waits and online steps of the migration runner on a Citus 14.2 coordinator plus ONE worker
 * (startTestPostgres({ workers: 1 })), where every shard of gizmos.gizmos sits on the worker. The
 * runner's sessions are on the coordinator; the ALTERs and index builds reach the shards over the
 * connections the coordinator opens to the worker, which start from the role's defaults (README,
 * "Lock waits" and "Online steps"). A blocker on the worker is a transaction there that a
 * coordinator session holds open through dblink (the nodes trust each other on their private
 * network), so the coordinator itself holds no lock on gizmos.
 *
 * All cases share database `app` and build on each other in file order. Each case sets the role
 * defaults it starts from. Opt-in (needs Docker; two containers, amd64 emulated on Apple Silicon):
 *   INTEGRATION=1 bunx vitest run --project database:int libs/database/test/citus-cluster.int-spec.ts
 */

const silent = { log: noop, warn: noop, error: noop, debug: noop };
const WORKER = testPostgresWorkerAlias(1);
/** A connection to the worker's database `app`, as the superuser, from the coordinator. */
const WORKER_DSN = `host=${WORKER} port=5432 dbname=app user=app`;
/** The same, with the shards visible (Citus hides them from catalog queries otherwise). */
const WORKER_SHARDS_DSN = `${WORKER_DSN} options='-c citus.override_table_visibility=off'`;
const TENANT = '0190a0a0-0000-7000-8000-000000000001';
/** The sets' lock_timeout in these cases (`lockWaitTimeoutMs`). */
const SET_TIMEOUT_MS = 500;

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'migrations on Citus 14.2: coordinator + one worker (lock waits and online steps)',
  () => {
    let pg: TestPostgres;
    let admin: Sql;
    /** A session on the coordinator's database `postgres`, where dblink is installed. */
    let probe: Sql;
    let probeUrl: string;

    const connect = (url: string): Sql => postgres(url, { max: 1, onnotice: noop });

    /** Runs `query` on a NEW connection to the worker; `columns` types its result. */
    const onWorker = <T extends object>(
      query: string,
      columns: string,
      dsn = WORKER_DSN,
    ): Promise<T[]> =>
      probe.unsafe<T[]>(`select * from dblink($1, $2) as t(${columns})`, [dsn, query]);

    /** What a new connection to the worker starts with, as the ones the coordinator opens do. */
    const workerLockTimeout = async (): Promise<string | undefined> => {
      const [row] = await onWorker<{ value: string }>('show lock_timeout', 'value text');
      return row?.value;
    };

    /** Locks on the worker that a backend is waiting for. */
    const workerWaits = async (): Promise<number> => {
      const [row] = await onWorker<{ waiting: number }>(
        'select count(*)::int from pg_locks where not granted',
        'waiting int',
      );
      return row?.waiting ?? 0;
    };

    /** One shard of gizmos.gizmos, schema-qualified (all of them sit on the worker). */
    const gizmosShard = async (): Promise<string> => {
      const [row] = await admin<{ name: string }[]>`
        select shard_name as name from citus_shards
        where table_name = 'gizmos.gizmos'::regclass order by shardid limit 1`;
      if (row === undefined) throw new Error('gizmos.gizmos has no shard');
      return row.name;
    };

    /**
     * A transaction on the worker, opened by a coordinator session through dblink, that holds
     * `mode` on one shard of gizmos.gizmos (`access share`: what a reader holds; `row exclusive`:
     * a writer) and stays open until `release`. Released when the test ends too, so a statement
     * still queued behind it can finish before afterAll.
     */
    const holdOnWorker = async (mode: 'access share' | 'row exclusive') => {
      const shard = await gizmosShard();
      const client = connect(probeUrl);
      await client`select dblink_connect('blocker', ${WORKER_DSN})`;
      // Citus refuses a LOCK on a shard on a worker unless manual changes to shards are allowed.
      await client`
        select dblink_exec('blocker', 'set citus.enable_manual_changes_to_shards = on')`;
      await client`select dblink_exec('blocker', 'begin')`;
      await client`select dblink_exec('blocker', ${`lock table ${shard} in ${mode} mode`})`;
      let open = true;
      const release = async (): Promise<void> => {
        if (!open) return;
        open = false;
        await client`select dblink_exec('blocker', 'commit')`;
      };
      onTestFinished(async () => {
        await release().catch(noop);
        await client.end({ timeout: 5 });
      });
      return { release };
    };

    /** The role's settings on the coordinator: role-wide (`app`: null) or in database app. */
    const setRoleTimeout = async (value: number, database: 'app' | null = null): Promise<void> => {
      await admin.unsafe(
        `alter role current_user ${database === null ? '' : `in database ${database} `}set lock_timeout = ${value}`,
      );
    };

    const migrationRows = async (set: DatabaseMigrationSet): Promise<number> => {
      const [row] = await admin<{ count: number }[]>`
        select count(*)::int as count
        from ${admin(set.migrationsSchema)}.${admin(set.migrationsTable)}`;
      return row?.count ?? -1;
    };

    const hasNoteColumn = async (): Promise<boolean> => {
      const [row] = await admin<{ present: boolean }[]>`
        select exists (
          select 1 from information_schema.columns
          where table_schema = 'gizmos' and table_name = 'gizmos' and column_name = 'note'
        ) as present`;
      return row?.present === true;
    };

    /** `gizmos.<name>`'s validity on the coordinator, or `undefined` when there is no such index. */
    const indexValid = async (name: string): Promise<boolean | undefined> => {
      const [row] = await admin<{ valid: boolean }[]>`
        select i.indisvalid as valid from pg_index i
        join pg_class c on c.oid = i.indexrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'gizmos' and c.relname = ${name}`;
      return row?.valid;
    };

    /** The validity of `gizmos.<name>`'s shard indexes on the worker, by shard id. */
    const shardIndexes = async (name: string): Promise<Record<string, boolean>> => {
      const rows = await onWorker<{ shard: string; valid: boolean }>(
        `select substring(c.relname from '[0-9]+$'), i.indisvalid from pg_index i
         join pg_class c on c.oid = i.indexrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'gizmos' and c.relname ~ '^${name}_[0-9]+$'`,
        'shard text, valid boolean',
        WORKER_SHARDS_DSN,
      );
      return Object.fromEntries(rows.map((row) => [row.shard, row.valid]));
    };

    /** gizmos.gizmos' shard ids, each with `valid` (what every shard index should end as). */
    const everyShard = async (valid: boolean): Promise<Record<string, boolean>> => {
      const rows = await admin<{ shard: string }[]>`
        select shardid::text as shard from pg_dist_shard
        where logicalrelid = 'gizmos.gizmos'::regclass`;
      return Object.fromEntries(rows.map((row) => [row.shard, valid]));
    };

    /** The online steps recorded for the gizmos set. */
    const recorded = async (): Promise<string[]> => {
      const rows = await admin<{ name: string }[]>`
        select name from gizmos.__online_migrations order by name`;
      return rows.map((row) => row.name);
    };

    beforeAll(async () => {
      // Never INTEGRATION_DATABASE_URL: an external database has no worker. The roles reach both
      // nodes, so the platform set's 0002 grants run.
      pg = await startTestPostgres({
        allowExternalUrl: false,
        initSql: readRolesInitSql(),
        workers: 1,
      });
      admin = connect(pg.url);
      const url = new URL(pg.url);
      url.pathname = '/postgres';
      probeUrl = url.toString();
      probe = connect(probeUrl);
      await probe`create extension if not exists dblink`;
      await runMigrations(pg.url, {
        migrations: [platformMigrations, gizmosTablesMigrations],
        logger: silent,
        lockWaitTimeoutMs: SET_TIMEOUT_MS,
      });
    });

    afterAll(async () => {
      await probe?.end({ timeout: 5 });
      await admin?.end({ timeout: 5 });
      await pg?.stop();
    });

    it('places every shard of gizmos.gizmos on the worker, none on the coordinator', async () => {
      const shards = await admin<{ nodename: string; shards: number }[]>`
        select nodename, count(*)::int as shards from citus_shards
        where table_name = 'gizmos.gizmos'::regclass group by nodename`;
      expect(shards).toEqual([{ nodename: WORKER, shards: 4 }]);
    });

    describe('lock waits (B1-7)', () => {
      it("a worker connection starts from the role's default, not from the session's lock_timeout", async () => {
        await setRoleTimeout(2_000);
        await holdOnWorker('access share');
        const session = postgres(pg.url, {
          max: 1,
          onnotice: noop,
          connection: { lock_timeout: 200 },
        });
        onTestFinished(() => session.end({ timeout: 5 }));
        const [own] = await session<{ lock_timeout: string }[]>`show lock_timeout`;
        expect(own?.lock_timeout).toBe('200ms');

        const started = Date.now();
        const error: unknown = await session`alter table gizmos.gizmos add column probe text`.catch(
          (caught: unknown) => caught,
        );

        // The coordinator's lock on the shell table is free; the shard's ALTER waited on the
        // worker for the role's 2 s, not the session's 200 ms.
        expect(error).toMatchObject({ code: '55P03' });
        expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
      });

      it('a blocker on a worker shard only makes the run fail with 55P03 within seconds, recording nothing', async () => {
        // An unbounded role default: only the runner's switch to the set timeout bounds the
        // shard connections' wait (without it the run waits as long as the blocker).
        await setRoleTimeout(0);
        await holdOnWorker('access share');

        const started = Date.now();
        const error: unknown = await runMigrations(pg.url, {
          migrations: [platformMigrations, gizmosTablesMigrations, gizmosLockWaitMigrations],
          logger: silent,
          lockWaitTimeoutMs: SET_TIMEOUT_MS,
          lockWaitRetries: 1,
          lockWaitRetryDelayMs: 200,
        }).catch((caught: unknown) => caught);

        expect(Date.now() - started).toBeLessThan(30_000);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(
          /^Migration set "gizmos-lock-wait" .* failed: lock_timeout \(500ms\) expired on all 2 attempts/,
        );
        expect((error as Error).cause).toMatchObject({ code: '55P03' });
        expect(await migrationRows(gizmosLockWaitMigrations)).toBe(0);
        expect(await hasNoteColumn()).toBe(false);
        expect(await workerLockTimeout()).toBe('500ms');
      });

      it("applies the set once when the blocker commits during the backoff, also through the role's per-database default", async () => {
        // The per-database setting takes precedence over the role-wide one (500 ms by now), so the
        // runner must change it, and Citus must carry that form to the worker.
        await setRoleTimeout(0, 'app');
        onTestFinished(async () => {
          await admin`alter role current_user in database app reset lock_timeout`;
        });
        expect(await workerLockTimeout()).toBe('0');
        const blocker = await holdOnWorker('access share');
        const warnings: string[] = [];

        const summary = await runMigrations(pg.url, {
          migrations: [platformMigrations, gizmosTablesMigrations, gizmosLockWaitMigrations],
          logger: {
            ...silent,
            warn: (message: unknown) => {
              warnings.push(String(message));
              // The first attempt timed out on the worker: end the blocker during the backoff.
              void blocker.release();
            },
          },
          lockWaitTimeoutMs: SET_TIMEOUT_MS,
          lockWaitRetries: 1,
          lockWaitRetryDelayMs: 1_000,
        });

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(
          /^gizmos-lock-wait: lock_timeout \(500ms\) expired \(55P03\); retry 1 of 1/,
        );
        expect(summary.sets.at(-1)).toMatchObject({ name: 'gizmos-lock-wait', applied: 1 });
        expect(await migrationRows(gizmosLockWaitMigrations)).toBe(1);
        expect(await hasNoteColumn()).toBe(true);
        expect(await workerLockTimeout()).toBe('500ms');
      });
    });

    describe('online steps (B1-7, B1-8)', () => {
      it('an online build on the distributed table waits out a blocker on the worker; valid on every shard; the role default is back afterwards', async () => {
        await setRoleTimeout(SET_TIMEOUT_MS);
        // A writer's lock on one shard: only the shard connections of the build meet it, and they
        // start from the role default, which the runner switches to the online value (0) for the
        // build. With the set timeout there, the build fails with 55P03 and leaves an invalid index.
        const blocker = await holdOnWorker('row exclusive');

        const run = runMigrations(pg.url, {
          migrations: [platformMigrations, gizmosMigrations],
          logger: silent,
          lockWaitTimeoutMs: SET_TIMEOUT_MS,
        });
        // The build waits on the worker: hold it there well past the set timeout, then release.
        await vi.waitFor(
          async () => {
            expect(await workerWaits()).toBeGreaterThan(0);
          },
          { timeout: 60_000, interval: 100 },
        );
        await sleep(3 * SET_TIMEOUT_MS);
        expect(await workerWaits()).toBeGreaterThan(0);
        await blocker.release();
        const summary = await run;

        expect(summary.online).toEqual({ total: 1, applied: 1 });
        expect(await recorded()).toEqual(['0000_gizmos_name_idx.sql']);
        expect(await indexValid('gizmos_name_idx')).toBe(true);
        expect(await shardIndexes('gizmos_name_idx')).toEqual(await everyShard(true));
        expect(await workerLockTimeout()).toBe('500ms');
      });

      it('a failed online build on the distributed table records nothing; the next run drops the invalid index and builds it valid on every shard', async () => {
        // Two rows of one tenant share a code: the unique build fails on that tenant's shard.
        await admin`
          insert into gizmos.gizmos (tenant_id, id, name, code)
          values (${TENANT}, 1, 'gizmo 1', 'dup'), (${TENANT}, 2, 'gizmo 2', 'dup')`;
        const migrations = [platformMigrations, gizmosWithOnline('online-retry')];

        const error: unknown = await runMigrations(pg.url, {
          migrations,
          logger: silent,
          lockWaitTimeoutMs: SET_TIMEOUT_MS,
        }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(
          /^Migration set "gizmos": online step 0000_gizmos_code_key\.sql \(.*\) failed; nothing was recorded for it/,
        );
        // The worker's error, as Citus relays it.
        expect((error as Error).cause).toMatchObject({
          code: '23505',
          where: expect.stringContaining(`on ${WORKER}:5432`),
        });
        expect(await recorded()).toEqual(['0000_gizmos_name_idx.sql']);
        // What a plain rerun of `IF NOT EXISTS` would then skip silently: invalid on the
        // coordinator and on the shard that holds the duplicates. (The other shards' builds run
        // in parallel, so whether they finished, failed or never started is not pinned.)
        expect(await indexValid('gizmos_code_key')).toBe(false);
        const [duplicates] = await admin<{ shard: string }[]>`
          select get_shard_id_for_distribution_column('gizmos.gizmos', ${TENANT}::uuid)::text
            as shard`;
        expect(await shardIndexes('gizmos_code_key')).toMatchObject({
          [duplicates?.shard ?? 'missing']: false,
        });

        await admin`delete from gizmos.gizmos where id = 2`;
        const warnings: string[] = [];
        const retry = await runMigrations(pg.url, {
          migrations,
          logger: { ...silent, warn: (message: unknown) => warnings.push(String(message)) },
          lockWaitTimeoutMs: SET_TIMEOUT_MS,
        });

        expect(warnings).toEqual([
          expect.stringMatching(/^gizmos: 0000_gizmos_code_key\.sql left the invalid index/),
        ]);
        expect(retry.online).toEqual({ total: 1, applied: 1 });
        expect(await recorded()).toEqual(['0000_gizmos_code_key.sql', '0000_gizmos_name_idx.sql']);
        expect(await indexValid('gizmos_code_key')).toBe(true);
        expect(await shardIndexes('gizmos_code_key')).toEqual(await everyShard(true));
      });
    });
  },
);
