import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from './start-test-postgres.js';

/*
 * The Citus test container itself. Opt-in (needs Docker; amd64 image, emulated on Apple Silicon):
 *   INTEGRATION=1 bunx vitest run --project testing:int
 */

const TENANT = '0190f3a0-0000-7000-8000-000000000001';
const READER_PASSWORD = 'p@ss:w/rd%41 é';

/** The notices of one router query on a distributed table, with Citus' command log on. */
async function routerQueryNotices(sql: Sql, notices: string[]): Promise<string[]> {
  await sql`create table if not exists probe_accounts (tenant_id uuid primary key)`;
  await sql`
    select create_distributed_table('probe_accounts', 'tenant_id')
    where not exists (
      select 1 from pg_dist_partition where logicalrelid = 'probe_accounts'::regclass)`;
  notices.length = 0;
  await sql`set citus.log_remote_commands = on`;
  await sql`select count(*) from probe_accounts where tenant_id = ${TENANT}`;
  await sql`reset citus.log_remote_commands`;
  return [...notices];
}

const connect = (url: string, notices: string[]): Sql =>
  postgres(url, {
    max: 1,
    onnotice: (notice) => {
      notices.push(notice['message'] ?? '');
    },
  });

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'startTestPostgres on citusdata/citus:14.2.0',
  () => {
    describe('defaults', () => {
      let pg: TestPostgres | undefined;
      let sql: Sql;
      const notices: string[] = [];

      beforeAll(async () => {
        pg = await startTestPostgres({
          allowExternalUrl: false,
          initSql: [
            `create role probe_reader login password '${READER_PASSWORD}'`,
            'create table init_marker (id int); insert into init_marker values (1)',
          ],
        });
        sql = connect(pg.url, notices);
      });

      afterAll(async () => {
        await sql?.end({ timeout: 5 });
        await pg?.stop();
        await pg?.stop(); // idempotent
      });

      it('runs Citus 14.2 on PostgreSQL 18 with 4 shards and local execution on', async () => {
        const [row] = await sql<{ citus: string; pg: number; shards: string; local: string }[]>`
        select citus_version() as citus, current_setting('server_version_num')::int as pg,
          current_setting('citus.shard_count') as shards,
          current_setting('citus.enable_local_execution') as local`;
        expect(row?.citus).toMatch(/^Citus 14\.2\./);
        expect(row?.pg).toBeGreaterThanOrEqual(180_000);
        expect(row).toMatchObject({ shards: '4', local: 'on' });
      });

      it('executes a router query on the local shard', async () => {
        const logged = await routerQueryNotices(sql, notices);
        expect(logged.some((message) => message.startsWith('executing the command locally'))).toBe(
          true,
        );
        expect(logged.some((message) => message.startsWith('issuing '))).toBe(false);
      });

      it('ran every initSql entry as the superuser, multi-statement entries included', async () => {
        const [row] = await sql<
          { count: number }[]
        >`select count(*)::int as count from init_marker`;
        expect(row?.count).toBe(1);
      });

      it('urlFor logs in as another role with URL-reserved characters in the password', async () => {
        const reader = postgres(pg!.urlFor('probe_reader', READER_PASSWORD), { max: 1 });
        try {
          const [row] = await reader<{ name: string }[]>`select current_user as name`;
          expect(row?.name).toBe('probe_reader');
        } finally {
          await reader.end({ timeout: 5 });
        }
      });
    });

    describe('localExecution: false', () => {
      let pg: TestPostgres | undefined;
      let sql: Sql;
      const notices: string[] = [];

      beforeAll(async () => {
        pg = await startTestPostgres({ allowExternalUrl: false, localExecution: false });
        sql = connect(pg.url, notices);
      });

      afterAll(async () => {
        await sql?.end({ timeout: 5 });
        await pg?.stop();
      });

      it('sends shard queries over connections even on one node', async () => {
        const [row] = await sql<{ local: string }[]>`
        select current_setting('citus.enable_local_execution') as local`;
        expect(row?.local).toBe('off');
        const logged = await routerQueryNotices(sql, notices);
        expect(logged.some((message) => message.startsWith('issuing '))).toBe(true);
        expect(logged.some((message) => message.startsWith('executing the command locally'))).toBe(
          false,
        );
      });
    });
  },
);
