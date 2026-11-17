import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfigModule } from '@platform/config';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import { noop } from 'lodash-es';
import { ClsModule } from 'nestjs-cls';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type BootGuardFinding,
  DatabaseBootGuardError,
  DatabaseModule,
  platformMigrations,
  runMigrations,
} from '../src/index.js';
import { guardedMigrations } from './fixtures/fixture-sets.js';

/*
 * The boot guard (Task 8) on citusdata/citus:14.2.0 with the three roles and local execution off
 * (startRlsTestPostgres). The platform set and a fixture set (one tenant-distributed table under
 * forced RLS) are migrated as app_owner; each case boots DatabaseModule once with
 * DATABASE_BOOT_GUARD=enforce, and every refusal must leave no backend of the app behind. Opt-in
 * (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project database:int libs/database/test/boot-guard.int-spec.ts
 */

const silent = { log: noop, warn: noop, error: noop, debug: noop };
const TABLE = 'guarded.records';
const BOOKKEEPING = 'guarded.__drizzle_migrations';

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'DatabaseModule boot guard on Citus 14.2 (enforce, three roles, local execution off)',
  () => {
    let pg: RlsTestPostgres;
    let admin: Sql;
    let owner: Sql;
    let bootCount = 0;

    /** Live sessions of the runtime and system pools of one service. */
    const sessionsOf = async (service: string): Promise<number> => {
      const [row] = await admin<{ count: number }[]>`
        select count(*)::int as count from pg_stat_activity
         where application_name in (${service}, ${`${service}:system`})`;
      return row?.count ?? -1;
    };

    /** Polls until no backend of `service` is left (pool ends are asynchronous on the server). */
    const settledSessionsOf = async (service: string): Promise<number> => {
      const deadline = Date.now() + 10_000;
      let left = await sessionsOf(service);
      while (left !== 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        left = await sessionsOf(service);
      }
      return left;
    };

    /** Boots one app context on these URLs (enforce); resolves with the service name it used. */
    const boot = async (urls: { runtime: string; system?: string }) => {
      bootCount += 1;
      const service = `guard-int-${bootCount}`;
      vi.stubEnv('DATABASE_URL', urls.runtime);
      vi.stubEnv('DATABASE_SYSTEM_URL', urls.system ?? '');
      vi.stubEnv('DATABASE_BOOT_GUARD', 'enforce');
      vi.stubEnv('DATABASE_POOL_MAX', '2');
      vi.stubEnv('DATABASE_SYSTEM_POOL_MAX', '2');
      vi.stubEnv('DATABASE_RUN_MIGRATIONS', 'false');
      vi.stubEnv('SERVICE_NAME', service);

      @Module({
        imports: [
          AppConfigModule.forRoot(),
          ClsModule.forRoot({ global: true }),
          DatabaseModule.forRootAsync({
            schema: {},
            migrations: [guardedMigrations],
            runMigrations: false,
          }),
        ],
      })
      class GuardIntegrationModule {}

      const app = NestFactory.createApplicationContext(GuardIntegrationModule, {
        logger: false,
        abortOnError: false,
      });
      return { service, app };
    };

    /** Boots, expects a refusal, and returns its findings once no backend of the app remains. */
    const refusal = async (urls: {
      runtime: string;
      system?: string;
    }): Promise<readonly BootGuardFinding[]> => {
      const { service, app } = await boot(urls);
      const error = await app.then(
        async (context) => {
          await context.close();
          return undefined;
        },
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DatabaseBootGuardError);
      expect(await settledSessionsOf(service)).toBe(0);
      return (error as DatabaseBootGuardError).findings;
    };

    const checksOf = (findings: readonly BootGuardFinding[]): string[] =>
      findings.map((finding) => finding.check);
    const findingOf = (
      findings: readonly BootGuardFinding[],
      check: string,
    ): BootGuardFinding | undefined => findings.find((finding) => finding.check === check);

    beforeAll(async () => {
      pg = await startRlsTestPostgres();
      await runMigrations(pg.migrationUrl, {
        migrations: [platformMigrations, guardedMigrations],
        logger: silent,
      });
      admin = postgres(pg.url, { max: 1, onnotice: noop });
      owner = postgres(pg.migrationUrl, { max: 1, onnotice: noop });
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    afterAll(async () => {
      await owner?.end({ timeout: 5 });
      await admin?.end({ timeout: 5 });
      await pg?.stop();
    });

    it('correct roles boot (runtime app_runtime, system app_system)', async () => {
      const { service, app } = await boot({ runtime: pg.runtimeUrl, system: pg.systemUrl });
      const context = await app;
      expect(await sessionsOf(service)).toBeGreaterThan(0);
      await context.close();
      expect(await settledSessionsOf(service)).toBe(0);
    }, 120_000);

    it('refuses the runtime URL as the superuser', async () => {
      const findings = await refusal({ runtime: pg.url, system: pg.systemUrl });
      expect(checksOf(findings)).toContain('runtime.not-superuser');
    }, 120_000);

    it('refuses the runtime URL as app_system', async () => {
      const findings = await refusal({ runtime: pg.systemUrl, system: pg.systemUrl });
      expect(checksOf(findings)).toContain('runtime.no-bypassrls');
      expect(checksOf(findings)).not.toContain('runtime.not-superuser');
    }, 120_000);

    it('refuses the runtime URL as app_owner', async () => {
      const findings = await refusal({ runtime: pg.migrationUrl, system: pg.systemUrl });
      expect(findingOf(findings, 'runtime.owns-no-table')?.detail).toContain(TABLE);
      expect(findingOf(findings, 'runtime.no-bookkeeping-privilege')?.detail).toContain(
        BOOKKEEPING,
      );
      expect(checksOf(findings)).not.toContain('runtime.not-superuser');
    }, 120_000);

    it('refuses a table with RLS enabled but not forced', async () => {
      await owner.unsafe(`alter table ${TABLE} no force row level security`);
      try {
        const findings = await refusal({ runtime: pg.runtimeUrl, system: pg.systemUrl });
        expect(findings).toEqual([
          { check: 'runtime.rls-forced', detail: expect.stringContaining(TABLE) as unknown },
        ]);
      } finally {
        await owner.unsafe(`alter table ${TABLE} force row level security`);
      }
    }, 120_000);

    it('refuses a table without RLS', async () => {
      await owner.unsafe(`alter table ${TABLE} disable row level security`);
      try {
        const findings = await refusal({ runtime: pg.runtimeUrl, system: pg.systemUrl });
        expect(findings).toEqual([
          { check: 'runtime.rls-forced', detail: expect.stringContaining(TABLE) as unknown },
        ]);
      } finally {
        await owner.unsafe(`alter table ${TABLE} enable row level security`);
      }
    }, 120_000);

    it('refuses GRANT SELECT on a bookkeeping table to app_runtime', async () => {
      await owner.unsafe(`grant select on ${BOOKKEEPING} to app_runtime`);
      try {
        const findings = await refusal({ runtime: pg.runtimeUrl, system: pg.systemUrl });
        expect(findings).toEqual([
          {
            check: 'runtime.no-bookkeeping-privilege',
            detail: expect.stringContaining(BOOKKEEPING) as unknown,
          },
        ]);
      } finally {
        await owner.unsafe(`revoke select on ${BOOKKEEPING} from app_runtime`);
      }
    }, 120_000);

    it('refuses app_runtime without citus.propagate_set_commands = local', async () => {
      await admin.unsafe('alter role app_runtime reset citus.propagate_set_commands');
      try {
        const findings = await refusal({ runtime: pg.runtimeUrl, system: pg.systemUrl });
        expect(checksOf(findings)).toEqual(['runtime.citus-propagate-set-commands']);
      } finally {
        await admin.unsafe("alter role app_runtime set citus.propagate_set_commands = 'local'");
      }
    }, 120_000);

    it('refuses the system URL as app_runtime', async () => {
      const findings = await refusal({ runtime: pg.runtimeUrl, system: pg.runtimeUrl });
      expect(checksOf(findings)).toEqual(['system.bypassrls', 'system.distinct-user']);
    }, 120_000);
  },
);
