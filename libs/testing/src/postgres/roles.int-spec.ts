import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type RlsTestPostgres,
  readRolesInitSql,
  startRlsTestPostgres,
  TEST_DB_ROLES,
} from './roles.js';
import { startTestPostgres, type TestPostgres } from './start-test-postgres.js';

/*
 * The database roles of docker/postgres/init (02-roles.sql, 03-pgbouncer-auth.sql) on the Citus test
 * container. Opt-in (needs Docker; amd64 image, emulated on Apple Silicon):
 *   INTEGRATION=1 bunx vitest run --project testing:int libs/testing/src/postgres/roles.int-spec.ts
 */

/** Nothing listens here: a helper that used it would fail to connect. */
const UNREACHABLE = 'postgres://nobody:nothing@127.0.0.1:1/none';
const POOLED_ROLE_SETTINGS = [
  'citus.propagate_set_commands=local',
  'statement_timeout=15s',
  'idle_in_transaction_session_timeout=60s',
];
/** PgBouncer's auth_user in production; its dev password equals its name, like the three roles. */
const PGBOUNCER_AUTH = 'pgbouncer_auth';

interface RoleRow {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcanlogin: boolean;
  rolconfig: string[] | null;
}

const connect = (url: string): Sql => postgres(url, { max: 1, onnotice: () => undefined });

async function withSession<T>(url: string, work: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = connect(url);
  try {
    return await work(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** The SQLSTATE a statement fails with, or undefined when it succeeds. */
async function sqlState(statement: Promise<unknown>): Promise<string | undefined> {
  try {
    await statement;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const userOf = (url: string): string => decodeURIComponent(new URL(url).username);

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'database roles from docker/postgres/init',
  () => {
    describe('startRlsTestPostgres()', () => {
      let pg: RlsTestPostgres | undefined;
      let admin: Sql;
      let roleUrls: Record<string, string>;

      const roles = async (): Promise<Map<string, RoleRow>> => {
        const names: string[] = [...Object.values(TEST_DB_ROLES), PGBOUNCER_AUTH];
        const rows = await admin<RoleRow[]>`
        select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcanlogin, rolconfig
        from pg_roles where rolname in ${admin(names)}`;
        return new Map(rows.map((row) => [row.rolname, row]));
      };

      beforeAll(async () => {
        // startRlsTestPostgres never uses a shared database, whatever the environment says.
        vi.stubEnv('INTEGRATION_DATABASE_URL', UNREACHABLE);
        pg = await startRlsTestPostgres();
        vi.unstubAllEnvs();
        admin = connect(pg.url);
        roleUrls = {
          [TEST_DB_ROLES.owner]: pg.migrationUrl,
          [TEST_DB_ROLES.runtime]: pg.runtimeUrl,
          [TEST_DB_ROLES.system]: pg.systemUrl,
        };
      });

      afterAll(async () => {
        vi.unstubAllEnvs();
        await admin?.end({ timeout: 5 });
        await pg?.stop();
      });

      it('reads 02-roles.sql, then 03-pgbouncer-auth.sql', () => {
        const [roleSql, authSql, ...rest] = readRolesInitSql();
        expect(rest).toEqual([]);
        expect(roleSql).toContain('CREATE ROLE app_runtime');
        expect(authSql).toContain('CREATE OR REPLACE FUNCTION pgbouncer.get_auth');
      });

      it('starts a container, and gives one URL per role besides the superuser url', () => {
        expect(pg!.url).not.toBe(UNREACHABLE);
        expect(userOf(pg!.url)).toBe('app');
        expect(userOf(pg!.migrationUrl)).toBe('app_owner');
        expect(userOf(pg!.runtimeUrl)).toBe('app_runtime');
        expect(userOf(pg!.systemUrl)).toBe('app_system');
      });

      it('creates the three roles with their attributes; each can log in', async () => {
        const rows = await roles();
        expect(rows.get('app_owner')).toMatchObject({
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcanlogin: true,
        });
        expect(rows.get('app_runtime')).toMatchObject({
          rolsuper: false,
          rolbypassrls: false,
          rolcanlogin: true,
        });
        expect(rows.get('app_system')).toMatchObject({
          rolsuper: false,
          rolbypassrls: true,
          rolcanlogin: true,
        });
        for (const [role, url] of Object.entries(roleUrls)) {
          const [row] = await withSession(
            url,
            (sql) => sql<{ user: string }[]>`select current_user as user`,
          );
          expect(row?.user).toBe(role);
        }
      });

      it('sets the pooled-role server settings on runtime and system only', async () => {
        const rows = await roles();
        for (const role of [TEST_DB_ROLES.runtime, TEST_DB_ROLES.system]) {
          expect(rows.get(role)?.rolconfig).toEqual(expect.arrayContaining(POOLED_ROLE_SETTINGS));
        }
        const ownerConfig = rows.get(TEST_DB_ROLES.owner)?.rolconfig ?? [];
        for (const setting of POOLED_ROLE_SETTINGS) {
          const name = setting.slice(0, setting.indexOf('='));
          expect(ownerConfig.filter((entry) => entry.startsWith(`${name}=`))).toEqual([]);
        }
      });

      it('starts every new session of each role on search_path pg_catalog, public', async () => {
        for (const url of Object.values(roleUrls)) {
          const [row] = await withSession(
            url,
            (sql) => sql<{ search_path: string }[]>`show search_path`,
          );
          expect(row?.search_path).toBe('pg_catalog, public');
        }
      });

      it('gives app_runtime local SET propagation, with local execution off', async () => {
        const [row] = await withSession(
          pg!.runtimeUrl,
          (sql) =>
            sql<{ propagate: string; local: string; timeout: string; idle: string }[]>`
          select current_setting('citus.propagate_set_commands') as propagate,
            current_setting('citus.enable_local_execution') as local,
            current_setting('statement_timeout') as timeout,
            current_setting('idle_in_transaction_session_timeout') as idle`,
        );
        expect(row).toEqual({ propagate: 'local', local: 'off', timeout: '15s', idle: '1min' });
      });

      it('lets only app_owner create a schema; the owner creates and distributes a table', async () => {
        for (const url of [pg!.runtimeUrl, pg!.systemUrl]) {
          await withSession(url, async (sql) => {
            expect(await sqlState(sql`create schema rls_probe_denied`)).toBe('42501');
          });
        }
        await withSession(pg!.migrationUrl, async (sql) => {
          // Separate transactions: with local execution off, Citus creates the shard over a new
          // connection, which cannot see a schema that is not committed yet.
          await sql`create schema rls_probe`;
          await sql`create table rls_probe.catalog (id int primary key)`;
          await sql`select create_reference_table('rls_probe.catalog')`;
          await sql`insert into rls_probe.catalog values (1)`;
          const [row] = await sql<
            { count: number }[]
          >`select count(*)::int as count from rls_probe.catalog`;
          expect(row?.count).toBe(1);
        });
        const [dist] = await admin<{ partmethod: string; repmodel: string; owner: string }[]>`
        select d.partmethod, d.repmodel, pg_get_userbyid(c.relowner) as owner
        from pg_dist_partition d join pg_class c on c.oid = d.logicalrelid
        where d.logicalrelid = 'rls_probe.catalog'::regclass`;
        expect(dist).toEqual({ partmethod: 'n', repmodel: 't', owner: 'app_owner' });
      });

      it('answers pgbouncer.get_auth for the two pooled roles only, and only to pgbouncer_auth', async () => {
        const [{ superuser } = { superuser: '' }] = await admin<
          { superuser: string }[]
        >`select current_user as superuser`;
        await withSession(pg!.urlFor(PGBOUNCER_AUTH, PGBOUNCER_AUTH), async (sql) => {
          for (const role of [TEST_DB_ROLES.runtime, TEST_DB_ROLES.system]) {
            const rows = await sql<{ usename: string; passwd: string }[]>`
            select usename, passwd from pgbouncer.get_auth(${role})`;
            expect(rows).toHaveLength(1);
            expect(rows[0]?.usename).toBe(role);
            expect(rows[0]?.passwd).toMatch(/^SCRAM-SHA-256\$/);
          }
          for (const name of [TEST_DB_ROLES.owner, superuser, PGBOUNCER_AUTH, 'no_such_role']) {
            const rows = await sql`select * from pgbouncer.get_auth(${name})`;
            expect({ name, rows: rows.length }).toEqual({ name, rows: 0 });
          }
        });
        for (const url of [pg!.runtimeUrl, pg!.systemUrl, pg!.migrationUrl]) {
          await withSession(url, async (sql) => {
            expect(
              await sqlState(sql`select * from pgbouncer.get_auth(${TEST_DB_ROLES.runtime})`),
            ).toBe('42501');
          });
        }
      });

      it('runs the script a second time without error, leaving every role as it was', async () => {
        const before = await roles();
        for (const statement of readRolesInitSql()) await admin.unsafe(statement).simple();
        expect(await roles()).toEqual(before);
        const [row] = await withSession(
          pg!.runtimeUrl,
          (sql) => sql<{ user: string }[]>`select current_user as user`,
        );
        expect(row?.user).toBe(TEST_DB_ROLES.runtime);
      });
    });

    describe('startTestPostgres() without options', () => {
      let pg: TestPostgres | undefined;

      beforeAll(async () => {
        vi.stubEnv('INTEGRATION_DATABASE_URL', UNREACHABLE);
        // The script twice on a fresh database: init order, and idempotence from the very first run.
        pg = await startTestPostgres({ initSql: [...readRolesInitSql(), ...readRolesInitSql()] });
        vi.unstubAllEnvs();
      });

      afterAll(async () => {
        vi.unstubAllEnvs();
        await pg?.stop();
      });

      it('ignores INTEGRATION_DATABASE_URL and starts its own container', async () => {
        expect(pg!.url).not.toBe(UNREACHABLE);
        const [row] = await withSession(
          pg!.urlFor(TEST_DB_ROLES.runtime, TEST_DB_ROLES.runtime),
          (sql) => sql<{ user: string; local: string }[]>`
          select current_user as user, current_setting('citus.enable_local_execution') as local`,
        );
        expect(row).toEqual({ user: 'app_runtime', local: 'on' });
      });
    });
  },
);
