import { Global, type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  createPrincipal,
  type Principal,
  PrincipalPermissions,
  runWithPrincipal,
} from '@platform/common';
import { AppConfigModule } from '@platform/config';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import { asc, eq, sql } from 'drizzle-orm';
import { integer, pgSchema, uuid } from 'drizzle-orm/pg-core';
import { noop } from 'lodash-es';
import { ClsModule } from 'nestjs-cls';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DatabaseModule,
  type DrizzleTransaction,
  type DrizzleTransactionHost,
  inUnitOfWork,
  platformMigrations,
  RlsElevation,
  runMigrations,
} from '../src/index.js';

/*
 * Elevation (Task 6) on citusdata/citus:14.2.0 with the three roles and local execution off
 * (startRlsTestPostgres): a Nest context whose pool (ONE connection) connects as app_runtime, and a
 * fixture table hash-distributed by tenant_id under FORCE RLS with the select policy
 * `tenant_id = app.tenant_id() AND (owner_id = app.user_id() OR app.elevated())`. Every case reads
 * the table BEFORE elevating, so the shard connections are already open when the mid-transaction
 * `SET LOCAL app.elevated = 'on'` has to reach them. Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project database:int libs/database/test/rls-elevation.int-spec.ts
 */

const silent = { log: noop, warn: noop, error: noop, debug: noop };
const USER_A = '0197a000-0000-7000-8000-00000000000a';
const USER_A2 = '0197a000-0000-7000-8000-00000000000c';
const USER_B = '0197a000-0000-7000-8000-00000000000b';
const TENANT_A = '0197a000-0000-7000-8000-0000000000a1';
const TENANT_B = '0197a000-0000-7000-8000-0000000000b2';
const FIXTURE = 'rls_fixture.docs';
const READ_ALL = 'orders:read-all';

const fixture = pgSchema('rls_fixture');
const docs = fixture.table('docs', {
  tenantId: uuid().notNull(),
  ownerId: uuid().notNull(),
  id: integer().notNull(),
});
const schema = { docs };
type Tx = DrizzleTransaction<typeof schema>;

/** An admin of A (holds READ_ALL), a plain member of A (holds nothing), a member of B. */
const adminOfA = createPrincipal({ userId: USER_A, tenantId: TENANT_A, roles: ['admin'] });
const memberOfA = createPrincipal({ userId: USER_A2, tenantId: TENANT_A, roles: ['member'] });
const ROW_1 = { tenantId: TENANT_A, ownerId: USER_A, id: 1 };
const ROW_2 = { tenantId: TENANT_A, ownerId: USER_A2, id: 2 };
const ROW_3 = { tenantId: TENANT_B, ownerId: USER_B, id: 3 };

/** What RbacModule.forRoot() binds in an app, without depending on @platform/auth here. */
@Global()
@Module({
  providers: [
    {
      provide: PrincipalPermissions,
      useValue: {
        of: (principal: Principal) => (principal.roles.includes('admin') ? [READ_ALL] : []),
      } satisfies PrincipalPermissions,
    },
  ],
  exports: [PrincipalPermissions],
})
class FixturePermissionsModule {}

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'RLS elevation on Citus 14.2 (app_runtime, local execution off)',
  () => {
    let pg: RlsTestPostgres;
    let admin: Sql;

    beforeAll(async () => {
      pg = await startRlsTestPostgres();
      await runMigrations(pg.migrationUrl, { migrations: [platformMigrations], logger: silent });
      admin = postgres(pg.url, { max: 1, onnotice: noop });
      const owner = postgres(pg.migrationUrl, { max: 1, onnotice: noop });
      try {
        // One autocommit statement each: with local execution off, Citus creates the shards over
        // new connections, which cannot see a schema that is not committed yet.
        for (const statement of [
          'create schema rls_fixture',
          `create table ${FIXTURE} (tenant_id uuid not null, owner_id uuid not null, id int not null, primary key (tenant_id, id))`,
          `select app.distribute_by_tenant('${FIXTURE}')`,
          `alter table ${FIXTURE} enable row level security`,
          `alter table ${FIXTURE} force row level security`,
          `create policy docs_select on ${FIXTURE} for select to app_runtime using (tenant_id = app.tenant_id() and (owner_id = app.user_id() or app.elevated()))`,
          'grant usage on schema rls_fixture to app_runtime',
          `grant select on ${FIXTURE} to app_runtime`,
        ]) {
          await owner.unsafe(statement);
        }
      } finally {
        await owner.end({ timeout: 5 });
      }
      // Seeded as the superuser: FORCE RLS filters the owner too.
      await admin.unsafe(
        `insert into ${FIXTURE} (tenant_id, owner_id, id) values ($1, $2, 1), ($1, $3, 2), ($4, $5, 3)`,
        [TENANT_A, USER_A, USER_A2, TENANT_B, USER_B],
      );
    });

    afterAll(async () => {
      await admin?.end({ timeout: 5 });
      await pg?.stop();
    });

    describe.each([true, false])('DATABASE_PREPARE=%s', (prepare) => {
      let app: INestApplicationContext;
      let txHost: DrizzleTransactionHost<typeof schema>;
      let elevation: RlsElevation;

      const rows = (tx: Tx) => tx.select().from(docs).orderBy(asc(docs.id));
      const settings = async (tx: Tx) => {
        const [row] = await tx.execute<{ elevated: boolean; tenant_id: string }>(
          sql`select app.elevated() as elevated, app.tenant_id() as tenant_id`,
        );
        return row;
      };
      /** The pool backend, read on its own (next to a distributed table it is pushed down). */
      const backend = async (tx: Tx) => {
        const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        return row?.pid;
      };
      const asUnit = <T>(principal: Principal, work: (tx: Tx) => Promise<T>): Promise<T> =>
        runWithPrincipal(principal, () => inUnitOfWork(txHost, work));

      beforeAll(async () => {
        vi.stubEnv('DATABASE_URL', pg.runtimeUrl);
        vi.stubEnv('DATABASE_PREPARE', String(prepare));
        vi.stubEnv('DATABASE_POOL_MAX', '1');
        vi.stubEnv('DATABASE_RUN_MIGRATIONS', 'false');
        vi.stubEnv('SERVICE_NAME', 'rls-elevation-int');

        @Module({
          imports: [
            AppConfigModule.forRoot(),
            ClsModule.forRoot({ global: true }),
            FixturePermissionsModule,
            DatabaseModule.forRootAsync({ schema, migrations: [], runMigrations: false }),
          ],
        })
        class ElevationIntegrationModule {}

        app = await NestFactory.createApplicationContext(ElevationIntegrationModule, {
          logger: false,
        });
        txHost = app.get(TransactionHost);
        elevation = app.get(RlsElevation);
      });

      afterAll(async () => {
        await app?.close();
        vi.unstubAllEnvs();
      });

      it('a member sees only its own rows', async () => {
        expect(await asUnit(adminOfA, rows)).toEqual([ROW_1]);
        expect(await asUnit(memberOfA, rows)).toEqual([ROW_2]);
      });

      it("after elevate() the same transaction sees the tenant's rows, never another tenant's", async () => {
        const seen = await asUnit(adminOfA, async (tx) => {
          const before = await rows(tx);
          await elevation.elevate(READ_ALL);
          return {
            before,
            after: await rows(tx),
            otherTenant: await tx.select().from(docs).where(eq(docs.tenantId, TENANT_B)),
            settings: await settings(tx),
          };
        });
        expect(seen.before).toEqual([ROW_1]);
        expect(seen.after).toEqual([ROW_1, ROW_2]);
        expect(seen.after).not.toContainEqual(ROW_3);
        expect(seen.otherTenant).toEqual([]);
        expect(seen.settings).toEqual({ elevated: true, tenant_id: TENANT_A });
      });

      it('the next transaction on the same pooled connection is not elevated', async () => {
        const elevated = await asUnit(adminOfA, async (tx) => {
          await rows(tx);
          await elevation.elevate(READ_ALL);
          return { pid: await backend(tx), rows: await rows(tx) };
        });
        const next = await asUnit(adminOfA, async (tx) => ({
          pid: await backend(tx),
          rows: await rows(tx),
          settings: await settings(tx),
        }));
        expect(elevated.rows).toEqual([ROW_1, ROW_2]);
        expect(next.pid).toBe(elevated.pid);
        expect(next.rows).toEqual([ROW_1]);
        expect(next.settings).toEqual({ elevated: false, tenant_id: TENANT_A });
      });

      it('justified() elevates for its callback only: after it returns, own rows again', async () => {
        const seen = await asUnit(memberOfA, async (tx) => {
          const before = await rows(tx);
          const inside = await elevation.justified('membership-activity', async () => ({
            rows: await rows(tx),
            settings: await settings(tx),
          }));
          return { before, inside, after: await rows(tx), settings: await settings(tx) };
        });
        expect(seen.before).toEqual([ROW_2]);
        expect(seen.inside).toEqual({
          rows: [ROW_1, ROW_2],
          settings: { elevated: true, tenant_id: TENANT_A },
        });
        expect(seen.after).toEqual([ROW_2]);
        expect(seen.settings).toEqual({ elevated: false, tenant_id: TENANT_A });
      });

      it('elevate() without the permission is refused before SQL: the transaction stays own-rows', async () => {
        const seen = await asUnit(memberOfA, async (tx) => {
          await rows(tx);
          const refusal = await elevation.elevate(READ_ALL).catch((error: unknown) => error);
          return { refusal, after: await rows(tx), settings: await settings(tx) };
        });
        expect(seen.refusal).toMatchObject({ code: 'ELEVATION_DENIED' });
        expect(seen.after).toEqual([ROW_2]);
        expect(seen.settings).toEqual({ elevated: false, tenant_id: TENANT_A });
      });
    });
  },
);
