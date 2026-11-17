import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import { noop } from 'lodash-es';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformMigrations, runMigrations } from '../src/index.js';
import { shardingMigrations } from './fixtures/fixture-sets.js';

/*
 * The sharding smoke spec (SH-11) on citusdata/citus:14.2.0: a coordinator and ONE worker on a
 * private network (startRlsTestPostgres({ workers: 1 })), the three roles on both, local execution
 * off. The platform set and the sharding fixture (a reference table and a tenant-distributed table,
 * both under forced RLS, policies calling app.user_id()) are migrated as app_owner. It proves the
 * mechanism across real nodes: the tenants' shards sit on the worker, so every context assertion
 * below needs SET LOCAL to cross the wire. Opt-in (needs Docker, amd64 emulated on Apple Silicon):
 *   INTEGRATION=1 bunx vitest run --project database:int libs/database/test/sharding.int-spec.ts
 */

const silent = { log: noop, warn: noop, error: noop, debug: noop };
const USER_ID = '0197a000-0000-7000-8000-00000000000a';
const TENANT_A = '0197a000-0000-7000-8000-0000000000a1';
const TENANT_B = '0197a000-0000-7000-8000-0000000000b2';
const SHIPMENTS = 'shipping.shipments';
const CARRIERS = 'shipping.carriers';
const COORDINATOR = 'coordinator';
const WORKER = 'worker1';

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

/** The context as the unit-of-work adapter sends it on BEGIN: SET LOCAL, one statement each here. */
async function setLocal(tx: TransactionSql, tenantId: string | null): Promise<void> {
  for (const [name, value] of Object.entries({
    'app.user_id': USER_ID,
    'app.tenant_id': tenantId ?? '',
    'app.elevated': 'off',
  })) {
    // Test-owned literals only: SET takes no bound parameters.
    await tx.unsafe(`SET LOCAL ${name} = '${value}'`);
  }
}

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'sharding smoke on Citus 14.2: coordinator + one worker (SET LOCAL across real nodes)',
  () => {
    let pg: RlsTestPostgres;
    let admin: Sql;
    let runtime: Sql;
    let system: Sql;

    /** Runs `work` as app_runtime in one transaction, in the context of `tenantId`. */
    const asRuntime = <T>(
      tenantId: string | null,
      work: (tx: TransactionSql) => Promise<T>,
    ): Promise<T> =>
      runtime.begin(async (tx) => {
        await setLocal(tx, tenantId);
        return work(tx);
      }) as Promise<T>;

    const shipments = (tx: TransactionSql) =>
      tx<
        { tenant_id: string; id: number }[]
      >`select tenant_id, id from shipping.shipments order by id`;

    beforeAll(async () => {
      pg = await startRlsTestPostgres({ workers: 1 });
      const summary = await runMigrations(pg.migrationUrl, {
        migrations: [platformMigrations, shardingMigrations],
        logger: silent,
      });
      expect(summary.sets).toEqual([
        expect.objectContaining({ name: 'platform', applied: 3 }),
        expect.objectContaining({ name: 'sharding', applied: 1 }),
      ]);
      admin = connect(pg.url);
      runtime = connect(pg.runtimeUrl);
      system = connect(pg.systemUrl);
      // Seeded as the superuser: FORCE RLS filters the owner too.
      await admin.unsafe(
        `insert into ${SHIPMENTS} (tenant_id, id) values ($1, 1), ($1, 2), ($2, 3)`,
        [TENANT_A, TENANT_B],
      );
    });

    afterAll(async () => {
      await system?.end({ timeout: 5 });
      await runtime?.end({ timeout: 5 });
      await admin?.end({ timeout: 5 });
      await pg?.stop();
    });

    it('creates the shards on the worker: both tenants live there, none on the coordinator', async () => {
      const nodes = await admin<{ nodename: string }[]>`
        select distinct nodename from citus_shards
         where table_name = ${SHIPMENTS}::regclass order by nodename`;
      expect(nodes).toEqual([{ nodename: WORKER }]);
      for (const tenantId of [TENANT_A, TENANT_B]) {
        const placements = await admin<{ nodename: string }[]>`
          select n.nodename from pg_dist_placement p join pg_dist_node n on n.groupid = p.groupid
           where p.shardid = get_shard_id_for_distribution_column(${SHIPMENTS}, ${tenantId}::uuid)`;
        expect(placements).toEqual([{ nodename: WORKER }]);
      }
      const [node] = await admin<{ nodename: string; shouldhaveshards: boolean }[]>`
        select nodename, shouldhaveshards from pg_dist_node where groupid = 0`;
      expect(node).toEqual({ nodename: COORDINATOR, shouldhaveshards: false });
    });

    it("a router query by tenant returns the tenant's rows", async () => {
      const rows = await asRuntime(
        TENANT_A,
        (tx) => tx<{ tenant_id: string; id: number }[]>`
          select tenant_id, id from shipping.shipments where tenant_id = ${TENANT_A} order by id`,
      );
      expect(rows).toEqual([
        { tenant_id: TENANT_A, id: 1 },
        { tenant_id: TENANT_A, id: 2 },
      ]);
      // The same router query for another tenant's key finds nothing in this context.
      expect(
        await asRuntime(
          TENANT_A,
          (tx) => tx`select id from shipping.shipments where tenant_id = ${TENANT_B}`,
        ),
      ).toHaveLength(0);
    });

    it("a multi-shard query returns only the tenant's rows", async () => {
      expect(await asRuntime(TENANT_A, shipments)).toEqual([
        { tenant_id: TENANT_A, id: 1 },
        { tenant_id: TENANT_A, id: 2 },
      ]);
      expect(await asRuntime(TENANT_B, shipments)).toEqual([{ tenant_id: TENANT_B, id: 3 }]);
      expect(await asRuntime(null, shipments)).toEqual([]);
    });

    it("the context reaches the worker: another tenant's row is refused by the shard table's RLS", async () => {
      const refused = await failure(
        asRuntime(
          TENANT_A,
          (tx) => tx`insert into shipping.shipments (tenant_id, id) values (${TENANT_B}, 9)`,
        ),
      );
      expect(refused?.code).toBe('42501');
      expect(refused?.message).toMatch(
        /^new row violates row-level security policy for table "shipments_\d+"/,
      );
      // Its own tenant's row passes the same WITH CHECK, and nothing leaked from the refusal.
      await asRuntime(
        TENANT_A,
        (tx) => tx`insert into shipping.shipments (tenant_id, id) values (${TENANT_A}, 9)`,
      );
      await admin.unsafe(`delete from ${SHIPMENTS} where id = 9`);
      expect(await admin`select id from shipping.shipments where tenant_id = ${TENANT_B}`).toEqual([
        { id: 3 },
      ]);
    });

    it('a mid-transaction elevate widens the next multi-shard read', async () => {
      const seen = await asRuntime(TENANT_A, async (tx) => {
        const before = await shipments(tx);
        // What elevate() sends: Citus prepends it to the remote BEGIN of the next statement.
        await tx.unsafe(`SET LOCAL app.elevated = 'on'`);
        const after = await shipments(tx);
        return { before, after };
      });
      expect(seen.before.map((row) => row.id)).toEqual([1, 2]);
      expect(seen.after).toEqual([
        { tenant_id: TENANT_A, id: 1 },
        { tenant_id: TENANT_A, id: 2 },
        { tenant_id: TENANT_B, id: 3 },
      ]);
      // The next transaction on the same pool is not elevated.
      expect((await asRuntime(TENANT_A, shipments)).map((row) => row.id)).toEqual([1, 2]);
    });

    it('set_config(…, true) in place of SET LOCAL never reaches the worker: app.user_id is not set', async () => {
      let coordinatorSees: string | undefined;
      const outcome = await failure(
        runtime.begin(async (tx) => {
          await tx`select set_config('app.user_id', ${USER_ID}, true),
            set_config('app.tenant_id', ${TENANT_A}, true),
            set_config('app.elevated', 'off', true)`;
          const [local] = await tx<{ id: string }[]>`select app.tenant_id() as id`;
          coordinatorSees = local?.id;
          await shipments(tx);
        }),
      );
      expect(coordinatorSees).toBe(TENANT_A);
      expect(outcome).toEqual({ code: '42501', message: 'app.user_id is not set' });
    });

    it('a reference-table write passes its WITH CHECK on every node', async () => {
      await asRuntime(
        TENANT_A,
        (tx) => tx`insert into shipping.carriers (code) values ('ups'), ('dhl')`,
      );
      const placements = await admin<{ nodename: string; result: string }[]>`
        select nodename, result from run_command_on_placements(${CARRIERS}, 'select count(*) from %s')
         order by nodename`;
      expect(placements).toEqual([
        { nodename: COORDINATOR, result: '2' },
        { nodename: WORKER, result: '2' },
      ]);
      const read = await asRuntime(
        TENANT_B,
        (tx) => tx<{ code: string }[]>`select code from shipping.carriers order by code`,
      );
      expect(read).toEqual([{ code: 'dhl' }, { code: 'ups' }]);
    });

    it('app_system reads all rows (BYPASSRLS on the worker too)', async () => {
      const rows = await system.begin(async (tx) => {
        for (const [name, value] of Object.entries({ 'app.user_id': USER_ID })) {
          await tx.unsafe(`SET LOCAL ${name} = '${value}'`);
        }
        return shipments(tx);
      });
      expect(rows).toEqual([
        { tenant_id: TENANT_A, id: 1 },
        { tenant_id: TENANT_A, id: 2 },
        { tenant_id: TENANT_B, id: 3 },
      ]);
    });

    it('the three roles exist on the worker with the coordinator attributes', async () => {
      const probe = `select string_agg(rolname || ':' || rolsuper::int || rolbypassrls::int, ',' order by rolname) from pg_roles where rolname in ('app_owner','app_runtime','app_system')`;
      const onWorkers = await admin<{ nodename: string; success: boolean; result: string }[]>`
        select nodename, success, result from run_command_on_workers(${probe})`;
      expect(onWorkers).toEqual([
        {
          nodename: WORKER,
          success: true,
          result: 'app_owner:00,app_runtime:00,app_system:01',
        },
      ]);
      const [onCoordinator] = await admin<{ result: string }[]>`
        select string_agg(rolname || ':' || rolsuper::int || rolbypassrls::int, ',' order by rolname) as result
          from pg_roles where rolname in ('app_owner','app_runtime','app_system')`;
      expect(onCoordinator?.result).toBe('app_owner:00,app_runtime:00,app_system:01');
    });
  },
);
