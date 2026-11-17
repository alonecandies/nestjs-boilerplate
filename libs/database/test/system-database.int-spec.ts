import { type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TransactionHost } from '@nestjs-cls/transactional';
import { createPrincipal, runWithPrincipal, SystemContext } from '@platform/common';
import { AppConfigModule } from '@platform/config';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import { asc, sql } from 'drizzle-orm';
import { integer, pgSchema, uuid } from 'drizzle-orm/pg-core';
import { noop } from 'lodash-es';
import { ClsModule } from 'nestjs-cls';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DatabaseModule,
  type DrizzleTransactionHost,
  defineSystemMethod,
  inUnitOfWork,
  platformMigrations,
  runMigrations,
  SYSTEM_DATABASE,
  type SystemDatabase,
} from '../src/index.js';

/*
 * The system pool (Task 7) on citusdata/citus:14.2.0 with the three roles and local execution off
 * (startRlsTestPostgres): DATABASE_URL connects as app_runtime, DATABASE_SYSTEM_URL as app_system
 * (BYPASSRLS). The fixture table is hash-distributed by tenant_id under FORCE RLS with NO policy, so
 * the runtime role sees nothing and only the system pool reads it. Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project database:int libs/database/test/system-database.int-spec.ts
 */

const silent = { log: noop, warn: noop, error: noop, debug: noop };
const USER_A = '0197a000-0000-7000-8000-00000000000a';
const TENANT_A = '0197a000-0000-7000-8000-0000000000a1';
const TENANT_B = '0197a000-0000-7000-8000-0000000000b2';
const FIXTURE = 'sys_fixture.items';
const SERVICE = 'sysdb-int';
const SYSTEM_POOL_MAX = 2;
const CONCURRENT = 20;

const fixture = pgSchema('sys_fixture');
const items = fixture.table('items', {
  tenantId: uuid().notNull(),
  id: integer().notNull(),
});
const schema = { items };
const SEEDED = [
  { tenantId: TENANT_A, id: 1 },
  { tenantId: TENANT_A, id: 2 },
  { tenantId: TENANT_B, id: 3 },
];

const memberOfA = createPrincipal({ userId: USER_A, tenantId: TENANT_A, roles: ['member'] });
const listAll = defineSystemMethod('fixtureItems.listAll', 'system');
const lookup = defineSystemMethod('fixtureItems.lookup', 'pre-auth');
const record = defineSystemMethod('fixtureItems.recordAsSystem', 'system');
const REASON = 'fixture.sweep';

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'SystemDatabase on Citus 14.2 (app_system pool next to app_runtime, local execution off)',
  () => {
    let pg: RlsTestPostgres;
    let admin: Sql;

    /** Live sessions of one application_name (Citus' own shard connections are named apart). */
    const sessionsOf = async (applicationName: string): Promise<number> => {
      const [row] = await admin<{ count: number }[]>`
        select count(*)::int as count from pg_stat_activity where application_name = ${applicationName}`;
      return row?.count ?? -1;
    };

    const boot = async (serviceName: string): Promise<INestApplicationContext> => {
      vi.stubEnv('DATABASE_URL', pg.runtimeUrl);
      vi.stubEnv('DATABASE_SYSTEM_URL', pg.systemUrl);
      vi.stubEnv('DATABASE_SYSTEM_POOL_MAX', String(SYSTEM_POOL_MAX));
      vi.stubEnv('DATABASE_POOL_MAX', '2');
      vi.stubEnv('DATABASE_RUN_MIGRATIONS', 'false');
      vi.stubEnv('SERVICE_NAME', serviceName);

      @Module({
        imports: [
          AppConfigModule.forRoot(),
          ClsModule.forRoot({ global: true }),
          DatabaseModule.forRootAsync({ schema, migrations: [], runMigrations: false }),
        ],
      })
      class SystemIntegrationModule {}

      return NestFactory.createApplicationContext(SystemIntegrationModule, { logger: false });
    };

    beforeAll(async () => {
      pg = await startRlsTestPostgres();
      await runMigrations(pg.migrationUrl, { migrations: [platformMigrations], logger: silent });
      admin = postgres(pg.url, { max: 1, onnotice: noop });
      const owner = postgres(pg.migrationUrl, { max: 1, onnotice: noop });
      try {
        // One autocommit statement each: with local execution off, Citus creates the shards over
        // new connections, which cannot see a schema that is not committed yet.
        for (const statement of [
          'create schema sys_fixture',
          `create table ${FIXTURE} (tenant_id uuid not null, id int not null, primary key (tenant_id, id))`,
          `select app.distribute_by_tenant('${FIXTURE}')`,
          `alter table ${FIXTURE} enable row level security`,
          `alter table ${FIXTURE} force row level security`,
          'grant usage on schema sys_fixture to app_runtime',
          'grant usage on schema sys_fixture to app_system',
          `grant select on ${FIXTURE} to app_runtime`,
          `grant select on ${FIXTURE} to app_system`,
          `grant insert on ${FIXTURE} to app_system`,
        ]) {
          await owner.unsafe(statement);
        }
      } finally {
        await owner.end({ timeout: 5 });
      }
      // Seeded as the superuser: FORCE RLS filters the owner too.
      await admin.unsafe(
        `insert into ${FIXTURE} (tenant_id, id) values ($1, 1), ($1, 2), ($2, 3)`,
        [TENANT_A, TENANT_B],
      );
    });

    afterAll(async () => {
      await admin?.end({ timeout: 5 });
      await pg?.stop();
      vi.unstubAllEnvs();
    });

    describe('one application context', () => {
      let app: INestApplicationContext;
      let txHost: DrizzleTransactionHost<typeof schema>;
      let system: SystemDatabase<typeof schema>;

      beforeAll(async () => {
        app = await boot(SERVICE);
        txHost = app.get(TransactionHost);
        system = app.get<SystemDatabase<typeof schema>>(SYSTEM_DATABASE);
      });

      afterAll(async () => {
        await app?.close();
      });

      it('the system handle reads every row across shards with no context; the runtime handle none', async () => {
        const [whoami] = await system.run(lookup, (db) =>
          db.execute<{ role: string; user_id: string | null }>(
            sql`select current_user as role, nullif(current_setting('app.user_id', true), '') as user_id`,
          ),
        );
        expect(whoami).toEqual({ role: 'app_system', user_id: null });

        const everything = await SystemContext.run(REASON, () =>
          system.run(listAll, (db) => db.select().from(items).orderBy(asc(items.id))),
        );
        expect(everything).toEqual(SEEDED);

        const runtime = await runWithPrincipal(memberOfA, () =>
          inUnitOfWork(txHost, (tx) => tx.select().from(items).orderBy(asc(items.id))),
        );
        expect(runtime).toEqual([]);
      });

      it('a system-scope method outside SystemContext is refused on the live pool', async () => {
        const work = vi.fn(async () => 'never');
        await expect(system.run(listAll, work)).rejects.toMatchObject({
          code: 'SYSTEM_CONTEXT_REQUIRED',
        });
        expect(work).not.toHaveBeenCalled();
      });

      it('a system call inside an open runtime transaction runs on another backend; its write survives the rollback', async () => {
        const id = 99;
        const rollback = new Error('roll back');
        const pids: { runtime?: number; system?: number } = {};
        await expect(
          runWithPrincipal(memberOfA, () =>
            inUnitOfWork(txHost, async (tx) => {
              const [runtime] = await tx.execute<{ pid: number }>(
                sql`select pg_backend_pid() as pid`,
              );
              pids.runtime = runtime?.pid;
              pids.system = await SystemContext.run(REASON, () =>
                system.run(record, async (db) => {
                  await db.insert(items).values({ tenantId: TENANT_B, id });
                  const [backend] = await db.execute<{ pid: number }>(
                    sql`select pg_backend_pid() as pid`,
                  );
                  return backend?.pid;
                }),
              );
              throw rollback;
            }),
          ),
        ).rejects.toBe(rollback);
        expect(pids.runtime).toEqual(expect.any(Number));
        expect(pids.system).toEqual(expect.any(Number));
        expect(pids.system).not.toBe(pids.runtime);
        const [survived] = await admin<{ count: number }[]>`
          select count(*)::int as count from sys_fixture.items where id = ${id}`;
        expect(survived?.count).toBe(1);
        await admin`delete from sys_fixture.items where id = ${id}`;
      });

      it(`${CONCURRENT} concurrent calls never use more than systemPoolMax (${SYSTEM_POOL_MAX}) backends`, async () => {
        let peak = 0;
        const pids = await SystemContext.run(REASON, () =>
          Promise.all(
            Array.from({ length: CONCURRENT }, () =>
              system.run(listAll, async (db) => {
                // Each call holds its connection for a while, so the calls overlap.
                const [row] = await db.execute<{ pid: number }>(
                  sql`select pg_backend_pid() as pid, pg_sleep(0.05)`,
                );
                peak = Math.max(peak, await sessionsOf(`${SERVICE}:system`));
                return row?.pid;
              }),
            ),
          ),
        );
        const distinct = new Set(pids);
        expect(distinct.has(undefined)).toBe(false);
        expect(distinct.size).toBeGreaterThan(0);
        expect(distinct.size).toBeLessThanOrEqual(SYSTEM_POOL_MAX);
        expect(peak).toBeGreaterThan(0);
        expect(peak).toBeLessThanOrEqual(SYSTEM_POOL_MAX);
      }, 120_000);
    });

    it('shutdown closes both pools', async () => {
      const service = 'sysdb-close';
      const app = await boot(service);
      // Both pools were warmed at boot (select 1), so each has a live session.
      expect(await sessionsOf(service)).toBeGreaterThan(0);
      expect(await sessionsOf(`${service}:system`)).toBeGreaterThan(0);
      await app.close();
      const deadline = Date.now() + 10_000;
      let left = { runtime: -1, system: -1 };
      do {
        left = {
          runtime: await sessionsOf(service),
          system: await sessionsOf(`${service}:system`),
        };
        if (left.runtime === 0 && left.system === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      expect(left).toEqual({ runtime: 0, system: 0 });
    }, 60_000);
  },
);
