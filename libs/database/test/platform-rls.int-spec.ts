import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import { noop } from 'lodash-es';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformMigrations, runMigrations } from '../src/index.js';

/*
 * The platform set's RLS helpers (0002_rls_helpers.sql) and grants on citusdata/citus:14.2.0, with
 * the three roles and local execution off (startRlsTestPostgres): migrated as app_owner, every case
 * as app_runtime in a transaction. Shard queries go over connections even on one node, so a setting
 * that does not reach the shards fails here as it would on a cluster. Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project database:int libs/database/test/platform-rls.int-spec.ts
 */

const silent = { log: noop, warn: noop, error: noop, debug: noop };
const USER_ID = '0197a000-0000-7000-8000-00000000000a';
const TENANT_A = '0197a000-0000-7000-8000-0000000000a1';
const TENANT_B = '0197a000-0000-7000-8000-0000000000b2';
const FIXTURE = 'rls_fixture.notes';

interface ErrorChain {
  message?: string;
  cause?: ErrorChain;
}

interface SqlFailure {
  code: string | undefined;
  message: string;
}

/** How `work` fails, or undefined when it succeeds. */
async function failure(work: Promise<unknown>): Promise<SqlFailure | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    return { code, message };
  }
}

const connect = (url: string): Sql => postgres(url, { max: 1, onnotice: noop });

/** The context as Task 5's adapter sends it: SET LOCAL, one statement per setting here. */
async function setLocal(tx: TransactionSql, settings: Record<string, string>): Promise<void> {
  for (const [name, value] of Object.entries(settings)) {
    // Test-owned literals only: SET takes no bound parameters.
    await tx.unsafe(`SET LOCAL ${name} = '${value}'`);
  }
}

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'platform RLS helpers and grants on Citus 14.2 (local execution off)',
  () => {
    let pg: RlsTestPostgres;
    let admin: Sql;
    let owner: Sql;
    let runtime: Sql;

    /** Runs `work` as app_runtime in one transaction (on the shared max: 1 connection). */
    const asRuntime = <T>(work: (tx: TransactionSql) => Promise<T>): Promise<T> =>
      runtime.begin(work) as Promise<T>;

    beforeAll(async () => {
      pg = await startRlsTestPostgres();
      const summary = await runMigrations(pg.migrationUrl, {
        migrations: [platformMigrations],
        logger: silent,
      });
      expect(summary.sets).toEqual([expect.objectContaining({ name: 'platform', applied: 3 })]);
      admin = connect(pg.url);
      owner = connect(pg.migrationUrl);
      runtime = connect(pg.runtimeUrl);
    });

    afterAll(async () => {
      await runtime?.end({ timeout: 5 });
      await owner?.end({ timeout: 5 });
      await admin?.end({ timeout: 5 });
      await pg?.stop();
    });

    describe('helpers', () => {
      it('app.user_id() raises 42501 "app.user_id is not set" with no setting on a new connection', async () => {
        const fresh = connect(pg.runtimeUrl);
        try {
          expect(await failure(fresh.begin((tx) => tx`select app.user_id()`))).toEqual({
            code: '42501',
            message: 'app.user_id is not set',
          });
        } finally {
          await fresh.end({ timeout: 5 });
        }
      });

      it('app.user_id() raises the same for an empty setting, and returns a UUID that is set', async () => {
        expect(
          await failure(
            asRuntime(async (tx) => {
              await setLocal(tx, { 'app.user_id': '' });
              return tx`select app.user_id()`;
            }),
          ),
        ).toEqual({ code: '42501', message: 'app.user_id is not set' });
        const [row] = await asRuntime(async (tx) => {
          await setLocal(tx, { 'app.user_id': USER_ID });
          return tx<{ id: string }[]>`select app.user_id() as id`;
        });
        expect(row?.id).toBe(USER_ID);
      });

      it('app.tenant_id() is NULL when unset or empty, and the UUID when set', async () => {
        const fresh = connect(pg.runtimeUrl);
        try {
          const [unset] = await fresh.begin(
            (tx) => tx<{ id: string | null }[]>`select app.tenant_id() as id`,
          );
          expect(unset).toEqual({ id: null });
        } finally {
          await fresh.end({ timeout: 5 });
        }
        const tenantFor = (value: string) =>
          asRuntime(async (tx) => {
            await setLocal(tx, { 'app.tenant_id': value });
            const [row] = await tx<{ id: string | null }[]>`select app.tenant_id() as id`;
            return row?.id;
          });
        expect(await tenantFor('')).toBeNull();
        expect(await tenantFor(TENANT_A)).toBe(TENANT_A);
      });

      it("app.elevated() is true only for the literal 'on'", async () => {
        const fresh = connect(pg.runtimeUrl);
        try {
          const [unset] = await fresh.begin(
            (tx) => tx<{ elevated: boolean }[]>`select app.elevated() as elevated`,
          );
          expect(unset).toEqual({ elevated: false });
        } finally {
          await fresh.end({ timeout: 5 });
        }
        const elevatedFor = (value: string) =>
          asRuntime(async (tx) => {
            await setLocal(tx, { 'app.elevated': value });
            const [row] = await tx<{ elevated: boolean }[]>`select app.elevated() as elevated`;
            return row?.elevated;
          });
        const answers: Record<string, boolean | undefined> = {};
        for (const value of ['on', 'off', 'true', '1', 'ON ', '']) {
          answers[value] = await elevatedFor(value);
        }
        expect(answers).toEqual({
          on: true,
          off: false,
          true: false,
          '1': false,
          'ON ': false,
          '': false,
        });
      });

      it('a new transaction on the same connection sees all three unset', async () => {
        const [first] = await asRuntime(async (tx) => {
          await setLocal(tx, {
            'app.user_id': USER_ID,
            'app.tenant_id': TENANT_A,
            'app.elevated': 'on',
          });
          return tx<{ pid: number; user_id: string; tenant_id: string; elevated: boolean }[]>`
            select pg_backend_pid() as pid, app.user_id() as user_id,
              app.tenant_id() as tenant_id, app.elevated() as elevated`;
        });
        expect(first).toMatchObject({ user_id: USER_ID, tenant_id: TENANT_A, elevated: true });
        const [after] = await asRuntime(
          (tx) => tx<{ pid: number; tenant_id: string | null; elevated: boolean }[]>`
            select pg_backend_pid() as pid, app.tenant_id() as tenant_id,
              app.elevated() as elevated`,
        );
        expect(after).toEqual({ pid: first?.pid, tenant_id: null, elevated: false });
        expect(await failure(asRuntime((tx) => tx`select app.user_id()`))).toEqual({
          code: '42501',
          message: 'app.user_id is not set',
        });
      });
    });

    describe('propagation to the shards (sharding design P-5)', () => {
      beforeAll(async () => {
        // As app_owner, one autocommit statement each: with local execution off, Citus creates the
        // shards over new connections, which cannot see a schema that is not committed yet.
        for (const statement of [
          'create schema rls_fixture',
          `create table ${FIXTURE} (tenant_id uuid not null, id int not null, primary key (tenant_id, id))`,
          `select app.distribute_by_tenant('${FIXTURE}')`,
          `alter table ${FIXTURE} enable row level security`,
          `alter table ${FIXTURE} force row level security`,
          `create policy notes_select on ${FIXTURE} for select to app_runtime using (tenant_id = app.tenant_id())`,
          'grant usage on schema rls_fixture to app_runtime',
          `grant select on ${FIXTURE} to app_runtime`,
        ]) {
          await owner.unsafe(statement);
        }
        // Seeded as the superuser: FORCE RLS filters the owner too.
        await admin.unsafe(
          `insert into ${FIXTURE} (tenant_id, id) values ($1, 1), ($1, 2), ($2, 3)`,
          [TENANT_A, TENANT_B],
        );
      });

      it('runs on a hash-distributed table, with local execution off for app_runtime', async () => {
        const [placement] = await admin<{ method: string; column: string; shards: number }[]>`
          select p.partmethod as method, column_to_column_name(p.logicalrelid, p.partkey) as column,
            (select count(*)::int from pg_dist_shard s where s.logicalrelid = p.logicalrelid) as shards
          from pg_dist_partition p where p.logicalrelid = ${FIXTURE}::regclass`;
        expect(placement).toEqual({ method: 'h', column: 'tenant_id', shards: 4 });
        const [row] = await asRuntime(
          (tx) => tx<{ local: string; propagate: string }[]>`
            select current_setting('citus.enable_local_execution') as local,
              current_setting('citus.propagate_set_commands') as propagate`,
        );
        expect(row).toEqual({ local: 'off', propagate: 'local' });
      });

      it("SET LOCAL reaches every shard: a multi-shard read shows exactly the tenant's rows", async () => {
        const rowsOf = (tenantId: string) =>
          asRuntime(async (tx) => {
            await setLocal(tx, {
              'app.user_id': USER_ID,
              'app.tenant_id': tenantId,
              'app.elevated': 'off',
            });
            return tx<{ tenant_id: string; id: number }[]>`
              select tenant_id, id from rls_fixture.notes order by id`;
          });
        expect(await rowsOf(TENANT_A)).toEqual([
          { tenant_id: TENANT_A, id: 1 },
          { tenant_id: TENANT_A, id: 2 },
        ]);
        expect(await rowsOf(TENANT_B)).toEqual([{ tenant_id: TENANT_B, id: 3 }]);
      });

      it('set_config(…, true) looks right on the coordinator but never reaches a shard', async () => {
        let coordinatorSees: string | undefined;
        let shardRows: unknown[] | undefined;
        const outcome = await failure(
          asRuntime(async (tx) => {
            await tx`select set_config('app.user_id', ${USER_ID}, true),
              set_config('app.tenant_id', ${TENANT_A}, true),
              set_config('app.elevated', 'off', true)`;
            const [local] = await tx<{ id: string }[]>`select app.tenant_id() as id`;
            coordinatorSees = local?.id;
            shardRows = [...(await tx`select tenant_id, id from rls_fixture.notes`)];
          }),
        );
        expect(coordinatorSees).toBe(TENANT_A);
        // Either a shard raises (a SQL error) or it sees no tenant: never the tenant's rows.
        if (outcome === undefined) expect(shardRows).toEqual([]);
        else expect(outcome.code).toMatch(/^[0-9A-Z]{5}$/);
      });
    });

    describe('privileges', () => {
      it('app_runtime cannot execute the distribution helpers, create in schema app or read its bookkeeping', async () => {
        for (const [statement, denied] of [
          [`select app.distribute_by_tenant('${FIXTURE}')`, 'function distribute_by_tenant'],
          [`select app.distribute_by_user('${FIXTURE}')`, 'function distribute_by_user'],
          [`select app.make_reference('${FIXTURE}')`, 'function make_reference'],
          [`select app.citus_table_kind('${FIXTURE}')`, 'function citus_table_kind'],
          ['create table app.runtime_probe (id int)', 'schema app'],
          ['select count(*) from app.__drizzle_migrations', 'table __drizzle_migrations'],
        ] as const) {
          const outcome = await failure(asRuntime((tx) => tx.unsafe(statement)));
          expect({ statement, outcome }).toEqual({
            statement,
            outcome: { code: '42501', message: `permission denied for ${denied}` },
          });
        }
      });

      it('app_runtime and app_system execute the four granted helpers', async () => {
        const rows = await admin<{ role: string; fn: string; allowed: boolean }[]>`
          select r.role, f.fn, has_function_privilege(r.role, f.fn, 'EXECUTE') as allowed
          from unnest(array['app_runtime', 'app_system']) as r(role)
          cross join unnest(array['app.user_id()', 'app.tenant_id()', 'app.elevated()',
            'app.citus_enabled()']) as f(fn)
          order by 1, 2`;
        expect(rows).toHaveLength(8);
        expect(rows.filter((row) => !row.allowed)).toEqual([]);
        const [row] = await asRuntime(
          (tx) => tx<{ citus: boolean }[]>`select app.citus_enabled() as citus`,
        );
        expect(row).toEqual({ citus: true });
      });

      it('PUBLIC executes no function in schema app', async () => {
        const rows = await admin<{ name: string }[]>`
          select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app' and (p.proacl is null or exists (
            select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
          order by 1`;
        expect(rows).toEqual([]);
      });

      it('a function app_owner creates afterwards is not executable by a fresh role', async () => {
        await owner.unsafe(
          'create function app.later_probe() returns int language sql stable as $$ select 1 $$',
        );
        await admin.unsafe("create role fresh_probe login password 'fresh_probe'");
        // USAGE on the schema, so only the function's own privilege can refuse the call.
        await admin.unsafe('grant usage on schema app to fresh_probe');
        const [row] = await admin<{ allowed: boolean }[]>`
          select has_function_privilege('fresh_probe', 'app.later_probe()', 'EXECUTE') as allowed`;
        expect(row).toEqual({ allowed: false });
        const fresh = connect(pg.urlFor('fresh_probe', 'fresh_probe'));
        try {
          expect((await failure(fresh`select app.later_probe()`))?.code).toBe('42501');
        } finally {
          await fresh.end({ timeout: 5 });
        }
      });
    });

    describe('runMigrations() as app_owner', () => {
      it('runs again once the node is a Citus coordinator with a distributed table: nothing to apply', async () => {
        const [node] = await admin<{ coordinator: boolean }[]>`
          select citus_is_coordinator() as coordinator`;
        expect(node).toEqual({ coordinator: true });
        const summary = await runMigrations(pg.migrationUrl, {
          migrations: [platformMigrations],
          logger: silent,
        });
        expect(summary).toMatchObject({ applied: 0, total: 3 });
      });

      it('stops at 0002, naming the role, on a server without the app roles', async () => {
        await admin`create database without_roles`;
        const url = new URL(pg.url);
        url.pathname = '/without_roles';
        // Roles are per server: hide one for this run only.
        await admin`alter role app_system rename to app_system_hidden`;
        const outcome = await runMigrations(url.toString(), {
          migrations: [platformMigrations],
          logger: silent,
        })
          .then(() => undefined)
          .catch((error: unknown) => error as ErrorChain)
          .finally(async () => {
            await admin`alter role app_system_hidden rename to app_system`;
          });
        expect(outcome?.message).toMatch(/^Migration set "platform" .* failed$/);
        const causes: string[] = [];
        for (let cause = outcome?.cause; cause !== undefined; cause = cause.cause) {
          causes.push(cause.message ?? '');
        }
        expect(causes).toContain('database role(s) missing: app_system');
      });
    });
  },
);
