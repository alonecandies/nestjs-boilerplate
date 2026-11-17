import { type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TransactionHost } from '@nestjs-cls/transactional';
import { createPrincipal, type Principal, runWithPrincipal, SystemContext } from '@platform/common';
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
  inUnitOfWork,
  platformMigrations,
  runMigrations,
} from '../src/index.js';

/*
 * The RLS context on BEGIN (Task 5) on citusdata/citus:14.2.0 with the three roles and local
 * execution off (startRlsTestPostgres): a Nest context whose pool connects as app_runtime, and a
 * fixture table hash-distributed by tenant_id under FORCE RLS with `tenant_id = app.tenant_id()`.
 * Shard queries go over connections even on one node, so a context that did not reach the shards
 * would show no rows (or raise) here, as on a cluster. Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project database:int libs/database/test/rls-context.int-spec.ts
 */

const silent = { log: noop, warn: noop, error: noop, debug: noop };
const USER_A = '0197a000-0000-7000-8000-00000000000a';
const USER_B = '0197a000-0000-7000-8000-00000000000b';
const TENANT_A = '0197a000-0000-7000-8000-0000000000a1';
const TENANT_B = '0197a000-0000-7000-8000-0000000000b2';
const FIXTURE = 'rls_fixture.notes';
const POOL_MAX = 4;
const CONCURRENT = 200;

const fixture = pgSchema('rls_fixture');
const notes = fixture.table('notes', {
  tenantId: uuid().notNull(),
  id: integer().notNull(),
});
const schema = { notes };

const memberOfA = createPrincipal({ userId: USER_A, tenantId: TENANT_A, roles: ['member'] });
const memberOfB = createPrincipal({ userId: USER_B, tenantId: TENANT_B, roles: ['member'] });
const ROWS_OF_A = [
  { tenantId: TENANT_A, id: 1 },
  { tenantId: TENANT_A, id: 2 },
];
const ROWS_OF_B = [{ tenantId: TENANT_B, id: 3 }];

interface ErrorChain {
  code?: string;
  cause?: ErrorChain;
}

/** The first SQLSTATE in an error's cause chain (drizzle wraps the postgres.js error). */
const sqlStateOf = (error: unknown): string | undefined => {
  for (let current = error as ErrorChain | undefined; current; current = current.cause) {
    if (typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code)) return current.code;
  }
  return undefined;
};

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'RLS context on BEGIN on Citus 14.2 (app_runtime, local execution off)',
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
          `create table ${FIXTURE} (tenant_id uuid not null, id int not null, primary key (tenant_id, id))`,
          `select app.distribute_by_tenant('${FIXTURE}')`,
          `alter table ${FIXTURE} enable row level security`,
          `alter table ${FIXTURE} force row level security`,
          `create policy notes_select on ${FIXTURE} for select to app_runtime using (tenant_id = app.tenant_id())`,
          `create policy notes_insert on ${FIXTURE} for insert to app_runtime with check (tenant_id = app.tenant_id())`,
          'grant usage on schema rls_fixture to app_runtime',
          `grant select on ${FIXTURE} to app_runtime`,
          `grant insert on ${FIXTURE} to app_runtime`,
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
    });

    describe.each([true, false])('DATABASE_PREPARE=%s', (prepare) => {
      let app: INestApplicationContext;
      let txHost: DrizzleTransactionHost<typeof schema>;
      /** Every context statement the pool sent (postgres.js `debug` sees each built query). */
      const contextStatements: string[] = [];

      const readAs = (principal: Principal) =>
        runWithPrincipal(principal, () =>
          inUnitOfWork(txHost, (tx) => tx.select().from(notes).orderBy(asc(notes.id))),
        );

      beforeAll(async () => {
        vi.stubEnv('DATABASE_URL', pg.runtimeUrl);
        vi.stubEnv('DATABASE_PREPARE', String(prepare));
        vi.stubEnv('DATABASE_POOL_MAX', String(POOL_MAX));
        vi.stubEnv('DATABASE_RUN_MIGRATIONS', 'false');
        vi.stubEnv('SERVICE_NAME', 'rls-int');

        @Module({
          imports: [
            AppConfigModule.forRoot(),
            ClsModule.forRoot({ global: true }),
            DatabaseModule.forRootAsync({
              schema,
              migrations: [],
              runMigrations: false,
              postgres: {
                debug: (_connection: number, query: string) => {
                  if (query.startsWith('SET LOCAL app.user_id')) contextStatements.push(query);
                },
              },
            }),
          ],
        })
        class RlsIntegrationModule {}

        app = await NestFactory.createApplicationContext(RlsIntegrationModule, { logger: false });
        txHost = app.get(TransactionHost);
      });

      afterAll(async () => {
        await app?.close();
        vi.unstubAllEnvs();
      });

      it('connects as app_runtime with the prepare setting under test', async () => {
        const [row] = await runWithPrincipal(memberOfA, () =>
          inUnitOfWork(txHost, (tx) =>
            tx.execute<{ role: string; user_id: string; tenant_id: string; elevated: boolean }>(
              sql`select current_user as role, app.user_id() as user_id,
                app.tenant_id() as tenant_id, app.elevated() as elevated`,
            ),
          ),
        );
        expect(row).toEqual({
          role: 'app_runtime',
          user_id: USER_A,
          tenant_id: TENANT_A,
          elevated: false,
        });
      });

      it("tenant A's principal reads exactly A's rows, B's exactly B's (a multi-shard read)", async () => {
        expect(await readAs(memberOfA)).toEqual(ROWS_OF_A);
        expect(await readAs(memberOfB)).toEqual(ROWS_OF_B);
      });

      it('rejects with RLS_NO_PRINCIPAL without a principal, and in a principal-less system context', async () => {
        const before = contextStatements.length;
        const work = vi.fn(async () => 'never');
        await expect(inUnitOfWork(txHost, work)).rejects.toMatchObject({
          code: 'RLS_NO_PRINCIPAL',
        });
        // SystemContext on the runtime pool, under a parent that has a principal: still refused.
        await expect(
          runWithPrincipal(memberOfA, () =>
            SystemContext.run('fixture.sweep', () => inUnitOfWork(txHost, work)),
          ),
        ).rejects.toMatchObject({ code: 'RLS_NO_PRINCIPAL' });
        expect(work).not.toHaveBeenCalled();
        expect(contextStatements).toHaveLength(before);
      });

      it("rejects an INSERT for another tenant (WITH CHECK); the principal's own passes", async () => {
        const id = prepare ? 101 : 201;
        let failure: unknown;
        try {
          await runWithPrincipal(memberOfA, () =>
            inUnitOfWork(txHost, (tx) => tx.insert(notes).values({ tenantId: TENANT_B, id })),
          );
        } catch (error) {
          failure = error;
        }
        expect(sqlStateOf(failure)).toBe('42501');

        // The own-tenant insert passes the policy; rolled back so the fixture stays as seeded.
        const rollback = new Error('roll back');
        await expect(
          runWithPrincipal(memberOfA, () =>
            inUnitOfWork(txHost, async (tx) => {
              await tx.insert(notes).values({ tenantId: TENANT_A, id });
              const own = await tx.select().from(notes).orderBy(asc(notes.id));
              expect(own).toEqual([...ROWS_OF_A, { tenantId: TENANT_A, id }]);
              throw rollback;
            }),
          ),
        ).rejects.toBe(rollback);
        const [count] = await admin<{ count: number }[]>`
          select count(*)::int as count from rls_fixture.notes where id = ${id}`;
        expect(count?.count).toBe(0);
      });

      it(`${CONCURRENT} concurrent transactions alternating A and B on a pool of ${POOL_MAX} see only their own rows`, async () => {
        const before = contextStatements.length;
        const results = await Promise.all(
          Array.from({ length: CONCURRENT }, (_, index) => {
            const principal = index % 2 === 0 ? memberOfA : memberOfB;
            return runWithPrincipal(principal, () =>
              inUnitOfWork(txHost, async (tx) => {
                // On its own: next to a distributed table, Citus pushes pg_backend_pid() down to
                // the shard connections, whose pids are not the pool's.
                const [backend] = await tx.execute<{ pid: number }>(
                  sql`select pg_backend_pid() as pid`,
                );
                const rows = await tx.execute<{ tenant_id: string; id: number }>(
                  sql`select tenant_id, id from rls_fixture.notes order by id`,
                );
                return { principal, pid: backend?.pid, rows: [...rows] };
              }),
            );
          }),
        );
        const pids = new Set<number>();
        for (const { principal, pid, rows } of results) {
          const expected = principal === memberOfA ? ROWS_OF_A : ROWS_OF_B;
          expect(rows.map(({ tenant_id, id }) => ({ tenantId: tenant_id, id }))).toEqual(expected);
          if (pid !== undefined) pids.add(pid);
        }
        expect(pids.size).toBeGreaterThan(0);
        expect(pids.size).toBeLessThanOrEqual(POOL_MAX);
        // One context statement per transaction, each with its own principal.
        const sent = contextStatements.slice(before);
        expect(sent).toHaveLength(CONCURRENT);
        expect(sent.filter((statement) => statement.includes(`'${TENANT_A}'`))).toHaveLength(
          CONCURRENT / 2,
        );
        expect(sent.filter((statement) => statement.includes(`'${TENANT_B}'`))).toHaveLength(
          CONCURRENT / 2,
        );
      }, 300_000);
    });
  },
);
