import { type INestApplicationContext, Injectable, Module, type Provider } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  InjectTransaction,
  type Transaction,
  Transactional,
  TransactionHost,
} from '@nestjs-cls/transactional';
import { AppConfigModule } from '@platform/config';
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
  { clsRoot = true }: { clsRoot?: boolean } = {},
): Promise<INestApplicationContext> {
  @Module({
    imports: [
      AppConfigModule.forRoot(),
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
    it('is global and exports DRIZZLE + the health contributor', () => {
      const mod = DatabaseModule.forRootAsync({ schema, migrations: [] });
      expect(mod).toMatchObject({ module: DatabaseModule, global: true });
      expect(mod.exports).toEqual([DRIZZLE, DatabaseHealthIndicator]);
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
      app = await boot({ schema, runMigrations: true, migrations: [itemsMigrations] });
      expect(runMigrations).toHaveBeenCalledWith(
        'postgres://app:app@localhost:5432/app',
        expect.objectContaining({
          applicationName: 'app',
          migrations: [platformMigrations, itemsMigrations],
        }),
      );
      const [migrateOrder] = vi.mocked(runMigrations).mock.invocationCallOrder;
      const [poolOrder] = vi.mocked(postgres).mock.invocationCallOrder;
      expect(migrateOrder).toBeLessThan(poolOrder ?? 0);
    });

    it('honours DATABASE_RUN_MIGRATIONS, and the option wins over it', async () => {
      vi.stubEnv('DATABASE_RUN_MIGRATIONS', 'true');
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

  describe('transactions (ClsModule.registerPlugins wiring)', () => {
    // Also guards the empty-config fix: no bare `set transaction` between begin and the inserts.
    it('@Transactional() runs both repository calls in ONE committed transaction', async () => {
      app = await boot({ schema }, [ItemsService]);
      await app.get(ItemsService).createPair();
      expect(fake.queries.slice(1)).toEqual([
        'begin',
        'insert into "items" ("id", "name") values ($1, $2)',
        'insert into "items" ("id", "name") values ($1, $2)',
        'commit',
      ]);
    });

    it('rolls back when the method throws', async () => {
      app = await boot({ schema }, [ItemsService]);
      await expect(app.get(ItemsService).createPair(true)).rejects.toThrow('boom');
      expect(fake.queries.at(-1)).toBe('rollback');
      expect(fake.queries).not.toContain('commit');
    });

    it('works without ClsModule.forRoot (scripts / workers without ObservabilityModule)', async () => {
      app = await boot({ schema }, [ItemsService], { clsRoot: false });
      await app.get(ItemsService).createPair();
      expect(fake.queries.at(1)).toBe('begin');
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
      await app.get(ItemsService).createPair();
      expect(fake.queries.slice(1, 3)).toEqual([
        'begin',
        'set transaction isolation level serializable',
      ]);
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
