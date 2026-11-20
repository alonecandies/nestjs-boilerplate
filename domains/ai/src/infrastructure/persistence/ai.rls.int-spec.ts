import { buildRlsContextSql, platformMigrations, runMigrations } from '@platform/database';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import { noop } from 'lodash-es';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { aiMigrations } from './ai.migrations.js';

/*
 * The ai tables' distribution, grants and row-level security (0000_init) on citusdata/citus:14.2.0
 * with the three roles and local execution off (startRlsTestPostgres): every shard query goes over a
 * remote connection, so a context that did not reach the shards fails here as on a cluster.
 * The real runner applies the platform set and ai's history as app_owner; the fixture is seeded as
 * the superuser; every case runs as raw postgres.js in one transaction opened with
 * buildRlsContextSql (what the adapter sends on BEGIN). An allowed case asserts the exact rows; a
 * forbidden read asserts none; a forbidden write asserts the error or zero rows, and is committed,
 * so the superuser snapshot after every case proves that nothing changed.
 * Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project ai:int ai.rls
 */

const silent = { log: noop, warn: noop, error: noop, debug: noop };

const TENANT_A = '0197d000-0000-7000-8000-0000000000a0';
const TENANT_B = '0197d000-0000-7000-8000-0000000000b0';
const A1 = '0197d000-0000-7000-8000-00000000a001'; // in tenant A
const A2 = '0197d000-0000-7000-8000-00000000a002'; // in tenant A
const B1 = '0197d000-0000-7000-8000-00000000b001'; // in tenant B

/** One conversation per user, each with one message and one usage row (same id per user). */
const OWNERS = [
  { tenant: TENANT_A, user: A1, id: '0197d000-0000-7000-8000-0000000a1001' },
  { tenant: TENANT_A, user: A2, id: '0197d000-0000-7000-8000-0000000a2001' },
  { tenant: TENANT_B, user: B1, id: '0197d000-0000-7000-8000-0000000b1001' },
] as const;
const [OWN_A1, OWN_A2, OWN_B1] = OWNERS;
const NEW_ID = '0197d000-0000-7000-8000-0000000e0001';

const TABLES = ['conversations', 'messages', 'usage'] as const;
type Table = (typeof TABLES)[number];

interface Context {
  readonly userId: string;
  readonly tenantId: string | null;
}
const a1InA: Context = { userId: A1, tenantId: TENANT_A };
const a2InA: Context = { userId: A2, tenantId: TENANT_A };
const b1InB: Context = { userId: B1, tenantId: TENANT_B };
/** a1 with B as the active tenant (a membership it does not have: RLS alone must hold). */
const a1InB: Context = { userId: A1, tenantId: TENANT_B };

interface SqlFailure {
  readonly code: string | undefined;
  readonly message: string;
}

async function failure(work: Promise<unknown>): Promise<SqlFailure | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    return { code, message };
  }
}

const RLS_VIOLATION = expect.objectContaining({
  code: '42501',
  message: expect.stringContaining('row-level security'),
});
const NO_PRIVILEGE = (table: string) =>
  expect.objectContaining({ code: '42501', message: `permission denied for table ${table}` });

class Rollback extends Error {}

const connect = (url: string): Sql => postgres(url, { max: 1, onnotice: noop });

async function inTransaction<T>(
  client: Sql,
  prelude: (tx: TransactionSql) => Promise<void>,
  work: (tx: TransactionSql) => Promise<T>,
  commit: boolean,
): Promise<T> {
  let result: T | undefined;
  try {
    await client.begin(async (tx) => {
      await prelude(tx);
      result = await work(tx);
      if (!commit) throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result as T;
}

const noContext = (): Promise<void> => Promise.resolve();

/** An insert of one row into `table` for (tenant, user): the minimal NOT NULL columns. */
function insertInto(tx: TransactionSql, table: Table, tenant: string, user: string) {
  switch (table) {
    case 'conversations':
      return tx`insert into ai.conversations (tenant_id, id, user_id, model)
        values (${tenant}, ${NEW_ID}, ${user}, 'm')`;
    case 'messages':
      return tx`insert into ai.messages (tenant_id, id, conversation_id, user_id, role, content)
        values (${tenant}, ${NEW_ID}, ${OWN_A1.id}, ${user}, 'user', ${tx.json('hi')})`;
    case 'usage':
      return tx`insert into ai.usage
          (tenant_id, id, user_id, conversation_id, model, latency_ms, outcome)
        values (${tenant}, ${NEW_ID}, ${user}, ${OWN_A1.id}, 'm', 1, 'success')`;
  }
}

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'ai RLS on Citus 14.2 (app_runtime, local execution off)',
  () => {
    let pg: RlsTestPostgres;
    let admin: Sql;
    let owner: Sql;
    let runtime: Sql;
    let system: Sql;
    let seeded: unknown[];

    const snapshot = async (): Promise<unknown[]> => [
      ...(await admin`select * from ai.conversations order by tenant_id, id`),
      ...(await admin`select * from ai.messages order by tenant_id, id`),
      ...(await admin`select * from ai.usage order by tenant_id, id`),
    ];

    const as = <T>(
      context: Context,
      work: (tx: TransactionSql) => Promise<T>,
      options: { commit?: boolean } = {},
    ): Promise<T> =>
      inTransaction(
        runtime,
        async (tx) => {
          await tx.unsafe(buildRlsContextSql(context)).simple();
        },
        work,
        options.commit ?? false,
      );
    const plain = <T>(
      client: Sql,
      work: (tx: TransactionSql) => Promise<T>,
      options: { commit?: boolean } = {},
    ): Promise<T> => inTransaction(client, noContext, work, options.commit ?? false);

    /** The ids of `table` the transaction sees (one row per owner: the owner's fixed id). */
    const idsOf =
      (table: Table) =>
      async (tx: TransactionSql): Promise<string[]> =>
        (await tx<{ id: string }[]>`select id from ${tx('ai')}.${tx(table)} order by id`).map(
          (row) => row.id,
        );

    beforeAll(async () => {
      pg = await startRlsTestPostgres();
      const summary = await runMigrations(pg.migrationUrl, {
        migrations: [platformMigrations, aiMigrations],
        logger: silent,
      });
      expect(summary.sets.map((set) => set.name)).toEqual(['platform', 'ai']);
      admin = connect(pg.url);
      owner = connect(pg.migrationUrl);
      runtime = connect(pg.runtimeUrl);
      system = connect(pg.systemUrl);
      for (const o of OWNERS) {
        await admin`insert into ai.conversations (tenant_id, id, user_id, title, model)
          values (${o.tenant}, ${o.id}, ${o.user}, 'title', 'm')`;
        await admin`insert into ai.messages (tenant_id, id, conversation_id, user_id, role, content)
          values (${o.tenant}, ${o.id}, ${o.id}, ${o.user}, 'user', ${admin.json('hello')})`;
        await admin`insert into ai.usage
            (tenant_id, id, user_id, conversation_id, message_id, model, latency_ms, outcome)
          values (${o.tenant}, ${o.id}, ${o.user}, ${o.id}, ${o.id}, 'm', 10, 'success')`;
      }
      seeded = await snapshot();
      expect(seeded).toHaveLength(OWNERS.length * TABLES.length);
    });

    afterEach(async () => {
      // Every forbidden write committed; every allowed one rolled back: nothing ever changes.
      await expect(snapshot()).resolves.toEqual(seeded);
    });

    afterAll(async () => {
      await system?.end({ timeout: 5 });
      await runtime?.end({ timeout: 5 });
      await owner?.end({ timeout: 5 });
      await admin?.end({ timeout: 5 });
      await pg?.stop();
    });

    describe('distribution, forced RLS and grants (deny by default)', () => {
      it('migrated as app_owner, with local execution off', async () => {
        const [row] = await admin<{ owners: string; local: string }[]>`
          select (select string_agg(distinct tableowner, ',') from pg_tables
              where schemaname = 'ai' and tablename = any(${[...TABLES]})) as owners,
            current_setting('citus.enable_local_execution') as local`;
        expect(row).toEqual({ owners: 'app_owner', local: 'off' });
      });

      it('distributes all three tables by tenant_id, colocated with app.tenant_colocation', async () => {
        const rows = await admin<{ name: string; kind: string; colocated: boolean }[]>`
          select t as name, app.citus_table_kind(('ai.' || t)::regclass) as kind,
            (select colocationid from pg_dist_partition
              where logicalrelid = ('ai.' || t)::regclass)
            = (select colocationid from pg_dist_partition
              where logicalrelid = 'app.tenant_colocation'::regclass) as colocated
          from unnest(array['conversations', 'messages', 'usage']) as t order by 1`;
        expect([...rows]).toEqual(
          TABLES.map((name) => ({ name, kind: 'hash:tenant_id', colocated: true })),
        );
      });

      it('enables and forces RLS on the three tables, and on neither ai.__drizzle_migrations', async () => {
        const rows = await admin<{ name: string; enabled: boolean; forced: boolean }[]>`
          select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'ai' and c.relname = any(${[...TABLES, '__drizzle_migrations']})
          order by c.relname`;
        expect([...rows]).toEqual([
          { name: '__drizzle_migrations', enabled: false, forced: false },
          ...TABLES.map((name) => ({ name, enabled: true, forced: true })),
        ]);
      });

      it('grants app_runtime S, I, U, D on conversations, S, I, D on messages, S, I on usage; app_system nothing', async () => {
        const rows = await admin<{ grantee: string; name: string; privileges: string }[]>`
          select a.grantee::regrole::text as grantee, c.relname as name,
            string_agg(a.privilege_type, ',' order by a.privilege_type) as privileges
          from pg_class c join pg_namespace n on n.oid = c.relnamespace,
            aclexplode(c.relacl) a
          where n.nspname = 'ai' and c.relname = any(${[...TABLES, '__drizzle_migrations']})
            and a.grantee <> c.relowner
          group by 1, 2 order by 1, 2`;
        expect([...rows]).toEqual([
          {
            grantee: 'app_runtime',
            name: 'conversations',
            privileges: 'DELETE,INSERT,SELECT,UPDATE',
          },
          { grantee: 'app_runtime', name: 'messages', privileges: 'DELETE,INSERT,SELECT' },
          { grantee: 'app_runtime', name: 'usage', privileges: 'INSERT,SELECT' },
        ]);
        const [schema] = await admin<{ runtime: boolean; system: boolean }[]>`
          select has_schema_privilege('app_runtime', 'ai', 'USAGE') as runtime,
            has_schema_privilege('app_system', 'ai', 'USAGE') as system`;
        expect(schema).toEqual({ runtime: true, system: false });
      });

      it('has exactly the nine app_runtime owner policies, none for any other role', async () => {
        const rows = await admin<{ name: string; command: string; roles: string }[]>`
          select tablename || '.' || policyname as name, cmd as command,
            array_to_string(roles, ',') as roles
          from pg_policies where schemaname = 'ai' and tablename = any(${[...TABLES]})
          order by 1`;
        const policy = (table: Table, command: string) => ({
          name: `${table}.${table}_${command.toLowerCase()}`,
          command,
          roles: 'app_runtime',
        });
        expect([...rows]).toEqual([
          policy('conversations', 'DELETE'),
          policy('conversations', 'INSERT'),
          policy('conversations', 'SELECT'),
          policy('conversations', 'UPDATE'),
          policy('messages', 'DELETE'),
          policy('messages', 'INSERT'),
          policy('messages', 'SELECT'),
          policy('usage', 'INSERT'),
          policy('usage', 'SELECT'),
        ]);
      });

      it('app_runtime cannot read ai.__drizzle_migrations; app_system reads no ai table', async () => {
        expect(await failure(as(a1InA, (tx) => tx`select * from ai.__drizzle_migrations`))).toEqual(
          NO_PRIVILEGE('__drizzle_migrations'),
        );
        for (const table of TABLES) {
          expect(await failure(plain(system, idsOf(table)))).toEqual(
            expect.objectContaining({ code: '42501', message: 'permission denied for schema ai' }),
          );
        }
      });

      it('FORCE: app_owner, the table owner, reads zero rows and cannot insert', async () => {
        for (const table of TABLES) {
          await expect(plain(owner, idsOf(table))).resolves.toEqual([]);
          expect(
            await failure(
              plain(owner, (tx) => insertInto(tx, table, TENANT_A, A1), { commit: true }),
            ),
          ).toEqual(RLS_VIOLATION);
        }
      });
    });

    describe.each(TABLES)('%s', (table) => {
      it('the owner reads exactly its rows', async () => {
        await expect(as(a1InA, idsOf(table))).resolves.toEqual([OWN_A1.id]);
        await expect(as(a2InA, idsOf(table))).resolves.toEqual([OWN_A2.id]);
        await expect(as(b1InB, idsOf(table))).resolves.toEqual([OWN_B1.id]);
      });

      it('another user of the tenant, the same user in another tenant and a tenant-less principal read none of them', async () => {
        const others = (tx: TransactionSql) =>
          tx<{ id: string }[]>`select id from ${tx('ai')}.${tx(table)}
            where tenant_id = ${TENANT_A} and user_id = ${A1}`;
        await expect(as(a2InA, others)).resolves.toHaveLength(0);
        await expect(as(a1InB, others)).resolves.toHaveLength(0);
        await expect(as(a1InB, idsOf(table))).resolves.toEqual([]);
        await expect(as({ userId: A1, tenantId: null }, idsOf(table))).resolves.toEqual([]);
      });

      it('the owner inserts its own row', async () => {
        await as(a1InA, async (tx) => {
          await insertInto(tx, table, TENANT_A, A1);
          await expect(idsOf(table)(tx)).resolves.toEqual([OWN_A1.id, NEW_ID].toSorted());
        });
      });

      it('an insert for another user or another tenant fails with 42501', async () => {
        for (const [context, tenant, user] of [
          [a1InA, TENANT_A, A2],
          [a1InA, TENANT_B, A1],
          [a1InA, TENANT_B, B1],
          [a1InB, TENANT_A, A1],
        ] as const) {
          expect(
            await failure(
              as(context, (tx) => insertInto(tx, table, tenant, user), { commit: true }),
            ),
          ).toEqual(RLS_VIOLATION);
        }
      });

      it('without a context, reads and writes are denied', async () => {
        let rows: string[] = [];
        const read = await failure(
          plain(runtime, async (tx) => {
            rows = await idsOf(table)(tx);
          }),
        );
        if (read === undefined) expect(rows).toEqual([]);
        else expect(read).toEqual({ code: '42501', message: 'app.user_id is not set' });
        expect(
          await failure(
            plain(runtime, (tx) => insertInto(tx, table, TENANT_A, A1), { commit: true }),
          ),
        ).toEqual(expect.objectContaining({ code: '42501' }));
      });
    });

    describe('changes', () => {
      it("conversations: the owner updates and deletes its own; another user's or tenant's match no row", async () => {
        const update = (tx: TransactionSql, id: string) =>
          tx`update ai.conversations set title = 'x' where tenant_id = ${TENANT_A} and id = ${id}
            returning id`;
        const remove = (tx: TransactionSql, id: string) =>
          tx`delete from ai.conversations where tenant_id = ${TENANT_A} and id = ${id} returning id`;

        await expect(as(a1InA, (tx) => update(tx, OWN_A1.id))).resolves.toHaveLength(1);
        await expect(as(a1InA, (tx) => remove(tx, OWN_A1.id))).resolves.toHaveLength(1);
        for (const context of [a2InA, a1InB, b1InB]) {
          await expect(
            as(context, (tx) => update(tx, OWN_A1.id), { commit: true }),
          ).resolves.toHaveLength(0);
          await expect(
            as(context, (tx) => remove(tx, OWN_A1.id), { commit: true }),
          ).resolves.toHaveLength(0);
        }
      });

      it('conversations: the owner cannot hand its conversation to another user', async () => {
        // tenant_id is the distribution column: Citus itself refuses to change it.
        const handOver = (tx: TransactionSql) =>
          tx`update ai.conversations set user_id = ${A2}
            where tenant_id = ${TENANT_A} and id = ${OWN_A1.id}`;
        expect(await failure(as(a1InA, handOver, { commit: true }))).toEqual(RLS_VIOLATION);
      });

      it("messages: the owner deletes its own; another user's or tenant's match no row; nobody updates", async () => {
        const remove = (tx: TransactionSql) =>
          tx`delete from ai.messages where tenant_id = ${TENANT_A} and id = ${OWN_A1.id}
            returning id`;
        await expect(as(a1InA, remove)).resolves.toHaveLength(1);
        for (const context of [a2InA, a1InB]) {
          await expect(as(context, remove, { commit: true })).resolves.toHaveLength(0);
        }
        expect(
          await failure(
            as(a1InA, (tx) => tx`update ai.messages set status = 'incomplete'`, { commit: true }),
          ),
        ).toEqual(NO_PRIVILEGE('messages'));
      });

      it('usage: insert-only, no UPDATE or DELETE even for the owner', async () => {
        expect(
          await failure(
            as(a1InA, (tx) => tx`update ai.usage set latency_ms = 1`, { commit: true }),
          ),
        ).toEqual(NO_PRIVILEGE('usage'));
        expect(
          await failure(as(a1InA, (tx) => tx`delete from ai.usage`, { commit: true })),
        ).toEqual(NO_PRIVILEGE('usage'));
      });
    });
  },
);
