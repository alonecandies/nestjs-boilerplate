import {
  type DynamicModule,
  Global,
  type INestApplicationContext,
  Injectable,
  Module,
  type Provider,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  InjectTransaction,
  type Transaction,
  Transactional,
  TransactionHost,
} from '@nestjs-cls/transactional';
import {
  createPrincipal,
  PrincipalPermissions,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import { AppConfigModule } from '@platform/config';
import { sql as drizzleSql } from 'drizzle-orm';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { ClsModule } from 'nestjs-cls';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSql, type FakeSql, type FakeSqlHandler } from '../test/fake-sql.js';
import { DatabaseModule } from './database.module.js';
import type { DatabaseMigrationSet, DatabaseModuleOptions } from './database.types.js';
import { DRIZZLE } from './drizzle/drizzle.constants.js';
import type { DrizzleDB, DrizzleTransactionalAdapter } from './drizzle/drizzle.types.js';
import { DatabaseHealthIndicator } from './health/database.health.js';
import { MIGRATIONS_TABLE } from './migrator/migrations.constants.js';
import { runMigrations } from './migrator/run-migrations.js';
import { platformMigrations } from './platform/platform.migrations.js';
import { RlsElevation } from './rls/rls-elevation.service.js';
import { SYSTEM_DATABASE, type SystemDatabase } from './system/system-database.js';
import { defineSystemMethod } from './system/system-method.js';

vi.mock('postgres', () => ({ default: vi.fn() }));
vi.mock('./migrator/run-migrations.js', () => ({
  runMigrations: vi.fn(async () => ({ sets: [], total: 0, applied: 0 })),
}));
// HealthContributor is an abstract marker class; mocking the barrel keeps this unit test free of
// observability's module graph (pino, prom-client, OpenTelemetry). DatabaseModule registers the
// db_pool_* gauges (PoolUsage); their scrape-time collect never runs here.
vi.mock('@platform/observability', () => ({
  HealthContributor: class HealthContributor {},
  getOrCreateGauge: () => undefined,
  getOrCreateCounter: () => ({ inc: () => undefined }),
}));

const items = pgTable('items', { id: uuid().primaryKey(), name: text().notNull() });
const schema = { items };
type Adapter = DrizzleTransactionalAdapter<typeof schema>;
const itemsMigrations: DatabaseMigrationSet = {
  name: 'items',
  folder: '/migrations/items',
  migrationsSchema: 'items',
  migrationsTable: MIGRATIONS_TABLE,
};
/** `migrations` defaults to none (the platform set alone) in these tests. */
type BootOptions = Omit<DatabaseModuleOptions<typeof schema>, 'migrations'> & {
  migrations?: readonly DatabaseMigrationSet[];
};

const ID_1 = '0199a1b2-0000-7000-8000-000000000001';
const ID_2 = '0199a1b2-0000-7000-8000-000000000002';
const USER = '0199a1b2-0000-7000-8000-0000000000a1';
const TENANT = '0199a1b2-0000-7000-8000-0000000000b1';
const principal = createPrincipal({ userId: USER, tenantId: TENANT, roles: ['member'] });
/** What the adapter sends right after BEGIN (Task 5: always on, from the CLS principal). */
const RLS_CONTEXT =
  `SET LOCAL app.user_id = '${USER}'; SET LOCAL app.tenant_id = '${TENANT}'; ` +
  `SET LOCAL app.elevated = 'off'`;
/** Runtime units of work always run as a principal. */
const asPrincipal = <T>(fn: () => T): T => runWithPrincipal(principal, fn);
const SYSTEM_URL = 'postgres://app_system:s@localhost:5432/app';
const sweep = defineSystemMethod('items.sweep', 'system');
const probe = defineSystemMethod('items.probe', 'pre-auth');

@Injectable()
class ItemsService {
  constructor(private readonly txHost: TransactionHost<Adapter>) {}

  /** Two statements that must commit or roll back together. */
  @Transactional()
  async createPair(fail = false): Promise<void> {
    await this.txHost.tx.insert(items).values({ id: ID_1, name: 'a' });
    await this.txHost.tx.insert(items).values({ id: ID_2, name: 'b' });
    if (fail) throw new Error('boom');
  }

  /** Outside `@Transactional()` the host falls back to the plain pool. */
  async createOne(): Promise<void> {
    await this.txHost.tx.insert(items).values({ id: ID_1, name: 'a' });
  }
}

@Injectable()
class ProxyUser {
  constructor(@InjectTransaction() readonly tx: Transaction<Adapter>) {}
}

async function boot(
  options: BootOptions,
  providers: Provider[] = [],
  {
    clsRoot = true,
    imports = [],
  }: { clsRoot?: boolean; imports?: (DynamicModule | (new () => unknown))[] } = {},
): Promise<INestApplicationContext> {
  @Module({
    imports: [
      AppConfigModule.forRoot(),
      ...imports,
      // Mounted by ObservabilityModule in the apps; DatabaseModule only registers its plugin.
      ...(clsRoot ? [ClsModule.forRoot({ global: true })] : []),
      DatabaseModule.forRootAsync({ migrations: [], ...options }),
    ],
    providers,
  })
  class TestAppModule {}
  return NestFactory.createApplicationContext(TestAppModule, {
    logger: false,
    abortOnError: false,
  });
}

describe('DatabaseModule', () => {
  let fake: FakeSql;
  let app: INestApplicationContext | undefined;

  const usePool = (handler?: FakeSqlHandler): void => {
    fake = createFakeSql(handler);
    vi.mocked(postgres).mockReturnValue(fake as never);
  };

  beforeEach(() => {
    usePool();
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
  });

  describe('forRootAsync() definition', () => {
    it('is global and exports DRIZZLE, the health contributor, RlsElevation and SYSTEM_DATABASE', () => {
      const mod = DatabaseModule.forRootAsync({ schema, migrations: [] });
      expect(mod).toMatchObject({ module: DatabaseModule, global: true });
      expect(mod.exports).toEqual([
        DRIZZLE,
        DatabaseHealthIndicator,
        RlsElevation,
        SYSTEM_DATABASE,
      ]);
    });

    it('registers the transactional CLS plugin unless disabled', () => {
      const isCls = (imported: unknown): boolean =>
        (imported as { module?: unknown }).module === ClsModule;
      expect(DatabaseModule.forRootAsync({ schema, migrations: [] }).imports?.some(isCls)).toBe(
        true,
      );
      expect(
        DatabaseModule.forRootAsync({ schema, migrations: [], transactional: false }).imports?.some(
          isCls,
        ),
      ).toBe(false);
    });

    it('rejects colliding migration sets when the module is defined', () => {
      expect(() =>
        DatabaseModule.forRootAsync({ schema, migrations: [platformMigrations] }),
      ).toThrow(/"platform" is listed twice/);
    });
  });

  describe('boot', () => {
    it('builds the pool from the database + app namespaces and warms it with select 1', async () => {
      app = await boot({ schema });
      expect(postgres).toHaveBeenCalledTimes(1);
      expect(postgres).toHaveBeenCalledWith(
        'postgres://app:app@localhost:5432/app',
        expect.objectContaining({
          max: 20,
          prepare: true,
          connection: expect.objectContaining({
            application_name: 'app',
            statement_timeout: 15_000,
          }) as unknown,
        }),
      );
      expect(fake.queries).toEqual(['select 1']);
      const db = app.get<DrizzleDB<typeof schema>>(DRIZZLE);
      // The pool behind the prepared-statements wrapper (see drizzle/prepared-statements.ts).
      expect(db.$client.options).toBe(fake.options);
      expect(db.query.items).toBeDefined(); // typed relational API from the passed schema
      expect(runMigrations).not.toHaveBeenCalled(); // DATABASE_RUN_MIGRATIONS defaults to false
    });

    it('runs the platform set, then the given sets, BEFORE opening the pool', async () => {
      vi.stubEnv('DATABASE_MIGRATION_URL', 'postgres://app_owner:o@localhost:5432/app');
      app = await boot({ schema, runMigrations: true, migrations: [itemsMigrations] });
      expect(runMigrations).toHaveBeenCalledWith(
        'postgres://app_owner:o@localhost:5432/app',
        expect.objectContaining({
          applicationName: 'app',
          migrations: [platformMigrations, itemsMigrations],
        }),
      );
      const [migrateOrder] = vi.mocked(runMigrations).mock.invocationCallOrder;
      const [poolOrder] = vi.mocked(postgres).mock.invocationCallOrder;
      expect(migrateOrder).toBeLessThan(poolOrder ?? 0);
    });

    it('refuses to migrate without DATABASE_MIGRATION_URL, before opening any connection', async () => {
      // Never a fallback to DATABASE_URL (the runtime role cannot and must not run DDL).
      vi.stubEnv('DATABASE_MIGRATION_URL', '');
      await expect(boot({ schema, runMigrations: true })).rejects.toThrow(/DATABASE_MIGRATION_URL/);
      expect(runMigrations).not.toHaveBeenCalled();
      expect(postgres).not.toHaveBeenCalled();
    });

    it('honours DATABASE_RUN_MIGRATIONS, and the option wins over it', async () => {
      vi.stubEnv('DATABASE_RUN_MIGRATIONS', 'true');
      vi.stubEnv('DATABASE_MIGRATION_URL', 'postgres://app_owner:o@localhost:5432/app');
      vi.stubEnv('SERVICE_NAME', 'orders-service');
      app = await boot({ schema });
      // No domain sets: the platform set still runs.
      expect(runMigrations).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          applicationName: 'orders-service',
          migrations: [platformMigrations],
        }),
      );
      await app.close();
      vi.mocked(runMigrations).mockClear();

      app = await boot({ schema, runMigrations: false });
      expect(runMigrations).not.toHaveBeenCalled();
    });

    it('retries transient connection errors at boot', async () => {
      let calls = 0;
      usePool(() => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
        return [{ '?column?': 1 }];
      });
      app = await boot({ schema });
      expect(calls).toBe(2);
    });

    it('fails fast on non-transient errors and releases the pool', async () => {
      usePool(() => {
        throw Object.assign(new Error('password authentication failed'), { code: '28P01' });
      });
      await expect(boot({ schema })).rejects.toThrow(/password authentication failed/);
      expect(fake.queries).toEqual(['select 1']);
      expect(fake.end).toHaveBeenCalledWith({ timeout: 0 });
    });

    it('drains the pool on shutdown', async () => {
      app = await boot({ schema });
      await app.close();
      app = undefined;
      expect(fake.end).toHaveBeenCalledWith({ timeout: 5 });
    });
  });

  describe('system pool (B3 Task 7)', () => {
    let system: FakeSql;
    /** The runtime pool first (DRIZZLE), then the system pool (SYSTEM_DATABASE). */
    const useSystemPool = (handler?: FakeSqlHandler): void => {
      system = createFakeSql(handler);
      vi.mocked(postgres).mockReset();
      vi.mocked(postgres)
        .mockReturnValueOnce(fake as never)
        .mockReturnValueOnce(system as never);
    };

    it('opens no system pool without DATABASE_SYSTEM_URL; every run is SYSTEM_DATABASE_UNAVAILABLE', async () => {
      app = await boot({ schema });
      expect(postgres).toHaveBeenCalledTimes(1);
      const database = app.get<SystemDatabase>(SYSTEM_DATABASE);
      const work = vi.fn(async () => 1);
      await expect(database.run(probe, work)).rejects.toMatchObject({
        code: 'SYSTEM_DATABASE_UNAVAILABLE',
      });
      await expect(
        SystemContext.run('items.nightly', () => database.run(sweep, work)),
      ).rejects.toMatchObject({ code: 'SYSTEM_DATABASE_UNAVAILABLE' });
      expect(work).not.toHaveBeenCalled();
      // Never a fallback to the runtime pool.
      expect(fake.queries).toEqual(['select 1']);
    });

    it('opens a second pool on DATABASE_SYSTEM_URL (systemPoolMax, :system name) after the runtime pool', async () => {
      vi.stubEnv('DATABASE_SYSTEM_URL', SYSTEM_URL);
      vi.stubEnv('DATABASE_SYSTEM_POOL_MAX', '3');
      useSystemPool();
      app = await boot({ schema, postgres: { max: 50 } });
      expect(postgres).toHaveBeenCalledTimes(2);
      expect(vi.mocked(postgres).mock.calls[0]?.[0]).toBe('postgres://app:app@localhost:5432/app');
      expect(postgres).toHaveBeenNthCalledWith(
        2,
        SYSTEM_URL,
        expect.objectContaining({
          // The overrides apply (TLS, debug), but never lift the system pool past its own max.
          max: 3,
          connection: expect.objectContaining({ application_name: 'app:system' }) as unknown,
        }),
      );
      expect(fake.queries).toEqual(['select 1']);
      expect(system.queries).toEqual(['select 1']);
    });

    it('runs work on the system pool, never on the runtime pool or its open transaction', async () => {
      vi.stubEnv('DATABASE_SYSTEM_URL', SYSTEM_URL);
      useSystemPool();
      app = await boot({ schema }, [ItemsService]);
      const database = app.get<SystemDatabase<typeof schema>>(SYSTEM_DATABASE);
      const txHost = app.get<TransactionHost<Adapter>>(TransactionHost);
      await asPrincipal(() =>
        txHost.withTransaction(async () => {
          await txHost.tx.insert(items).values({ id: ID_1, name: 'a' });
          await database.run(probe, (db) => db.execute(drizzleSql`select 7`));
        }),
      );
      await SystemContext.run('items.nightly', () => database.run(sweep, (db) => db.delete(items)));
      expect(fake.queries.slice(1)).toEqual([
        'begin',
        RLS_CONTEXT,
        'insert into "items" ("id", "name") values ($1, $2)',
        'commit',
      ]);
      // No context statement and no BEGIN on the system pool: it is not a runtime transaction.
      expect(system.queries).toEqual(['select 1', 'select 7', 'delete from "items"']);
      expect(system.begin).not.toHaveBeenCalled();
    });

    it('refuses a system-scope method outside SystemContext, sending nothing', async () => {
      vi.stubEnv('DATABASE_SYSTEM_URL', SYSTEM_URL);
      useSystemPool();
      app = await boot({ schema });
      const database = app.get<SystemDatabase<typeof schema>>(SYSTEM_DATABASE);
      await expect(
        asPrincipal(() => database.run(sweep, (db) => db.delete(items))),
      ).rejects.toMatchObject({ code: 'SYSTEM_CONTEXT_REQUIRED' });
      expect(system.queries).toEqual(['select 1']);
    });

    it('closes both pools on shutdown', async () => {
      vi.stubEnv('DATABASE_SYSTEM_URL', SYSTEM_URL);
      useSystemPool();
      app = await boot({ schema });
      await app.close();
      app = undefined;
      expect(fake.end).toHaveBeenCalledWith({ timeout: 5 });
      expect(system.end).toHaveBeenCalledWith({ timeout: 5 });
    });

    it('fails boot when the system pool is unreachable, releasing both pools', async () => {
      vi.stubEnv('DATABASE_SYSTEM_URL', SYSTEM_URL);
      useSystemPool(() => {
        throw Object.assign(new Error('password authentication failed'), { code: '28P01' });
      });
      await expect(boot({ schema })).rejects.toThrow(/password authentication failed/);
      expect(system.end).toHaveBeenCalledWith({ timeout: 0 });
      expect(fake.end).toHaveBeenCalledWith({ timeout: 0 });
    });
  });

  describe('transactions (ClsModule.registerPlugins wiring)', () => {
    // Also guards the empty-config fix: no bare `set transaction` between begin and the inserts.
    it('@Transactional() runs both repository calls in ONE committed transaction', async () => {
      app = await boot({ schema }, [ItemsService]);
      const service = app.get(ItemsService);
      await asPrincipal(() => service.createPair());
      expect(fake.queries.slice(1)).toEqual([
        'begin',
        RLS_CONTEXT,
        'insert into "items" ("id", "name") values ($1, $2)',
        'insert into "items" ("id", "name") values ($1, $2)',
        'commit',
      ]);
    });

    it('rolls back when the method throws', async () => {
      app = await boot({ schema }, [ItemsService]);
      const service = app.get(ItemsService);
      await expect(asPrincipal(() => service.createPair(true))).rejects.toThrow('boom');
      expect(fake.queries.at(-1)).toBe('rollback');
      expect(fake.queries).not.toContain('commit');
    });

    it('works without ClsModule.forRoot (scripts / workers without ObservabilityModule)', async () => {
      app = await boot({ schema }, [ItemsService], { clsRoot: false });
      const service = app.get(ItemsService);
      await asPrincipal(() => service.createPair());
      expect(fake.queries.slice(1, 3)).toEqual(['begin', RLS_CONTEXT]);
      expect(fake.queries.at(-1)).toBe('commit');
    });

    it('falls back to the pool outside a transaction (no CLS context needed)', async () => {
      app = await boot({ schema }, [ItemsService]);
      await app.get(ItemsService).createOne();
      expect(fake.queries.slice(1)).toEqual(['insert into "items" ("id", "name") values ($1, $2)']);
      expect(fake.begin).not.toHaveBeenCalled();
    });

    it('applies defaultTxOptions to every transaction', async () => {
      app = await boot(
        { schema, transactional: { defaultTxOptions: { isolationLevel: 'serializable' } } },
        [ItemsService],
      );
      const service = app.get(ItemsService);
      await asPrincipal(() => service.createPair());
      expect(fake.queries.slice(1, 4)).toEqual([
        'begin',
        'set transaction isolation level serializable',
        RLS_CONTEXT,
      ]);
    });

    it('provides RlsElevation over the globally bound PrincipalPermissions (B3 Task 6)', async () => {
      @Global()
      @Module({
        providers: [
          {
            provide: PrincipalPermissions,
            useValue: { of: () => ['items:read-all'] } satisfies PrincipalPermissions,
          },
        ],
        exports: [PrincipalPermissions],
      })
      class PermissionsModule {}
      app = await boot({ schema }, [ItemsService], { imports: [PermissionsModule] });
      const txHost = app.get<TransactionHost<Adapter>>(TransactionHost);
      const elevation = app.get(RlsElevation);
      await asPrincipal(() => txHost.withTransaction(() => elevation.elevate('items:read-all')));
      expect(fake.queries.slice(1)).toEqual([
        'begin',
        RLS_CONTEXT,
        "SET LOCAL app.elevated = 'on'",
        'commit',
      ]);
    });

    it('still boots without PrincipalPermissions; elevate then refuses and sends nothing', async () => {
      app = await boot({ schema }, [ItemsService]);
      const txHost = app.get<TransactionHost<Adapter>>(TransactionHost);
      const elevation = app.get(RlsElevation);
      await expect(
        asPrincipal(() => txHost.withTransaction(() => elevation.elevate('items:read-all'))),
      ).rejects.toThrow(/PrincipalPermissions is not bound/);
      expect(fake.queries.slice(1)).toEqual(['begin', RLS_CONTEXT, 'rollback']);
    });

    it('refuses to open a transaction without a principal (RLS_NO_PRINCIPAL, no BEGIN)', async () => {
      app = await boot({ schema }, [ItemsService]);
      await expect(app.get(ItemsService).createPair()).rejects.toMatchObject({
        code: 'RLS_NO_PRINCIPAL',
      });
      expect(fake.begin).not.toHaveBeenCalled();
    });

    it('provides @InjectTransaction() only when enableTransactionProxy is set', async () => {
      app = await boot({ schema, transactional: { enableTransactionProxy: true } }, [ProxyUser]);
      expect(app.get(ProxyUser).tx).toBeDefined();
      await app.close();
      app = undefined;
      await expect(boot({ schema }, [ProxyUser])).rejects.toThrow();
    });

    it('without the plugin TransactionHost is not provided', async () => {
      await expect(boot({ schema, transactional: false }, [ItemsService])).rejects.toThrow(
        /TransactionHost/,
      );
    });
  });
});
