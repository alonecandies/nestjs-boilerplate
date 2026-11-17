import {
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { type AppConfig, appConfig, type DatabaseConfig, databaseConfig } from '@platform/config';
import { isObject } from 'lodash-es';
import { ClsModule } from 'nestjs-cls';
import type { DatabaseModuleOptions, DatabaseTransactionalOptions } from './database.types.js';
import { DATABASE_MODULE_OPTIONS, DRIZZLE } from './drizzle/drizzle.constants.js';
import { createDrizzleDatabase, createSystemDrizzleDatabase } from './drizzle/drizzle.factory.js';
import type { DrizzleDB, DrizzleSchema } from './drizzle/drizzle.types.js';
import { DrizzlePostgresTransactionalAdapter } from './drizzle/drizzle-transactional.adapter.js';
import { InjectDrizzle } from './drizzle/inject-drizzle.decorator.js';
import { DatabaseHealthIndicator } from './health/database.health.js';
import { withPlatformMigrations } from './migrator/migration-sets.js';
import { RlsElevation } from './rls/rls-elevation.service.js';
import { SYSTEM_DATABASE, SYSTEM_POOL, SystemDatabase } from './system/system-database.js';

/** How long `end()` lets in-flight queries finish on shutdown before destroying sockets. */
const POOL_END_TIMEOUT_SEC = 5;

/** Closes both pools when Nest shuts down (requires `app.enableShutdownHooks()`). */
@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger('DatabaseModule');

  constructor(
    @InjectDrizzle() private readonly db: DrizzleDB,
    @Inject(SYSTEM_POOL) private readonly systemDb: DrizzleDB | null,
  ) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    await Promise.all([
      this.db.$client.end({ timeout: POOL_END_TIMEOUT_SEC }),
      this.systemDb?.$client.end({ timeout: POOL_END_TIMEOUT_SEC }),
    ]);
    this.logger.log(
      `Postgres ${this.systemDb === null ? 'pool' : 'pools'} closed (${signal ?? 'shutdown'})`,
    );
  }
}

/**
 * The system pool opens after the runtime pool (after migrations and its warm-up); when it
 * cannot, the runtime pool is released too, so a failed boot leaves no connection behind.
 */
async function openSystemPool<TSchema extends DrizzleSchema>(
  cfg: DatabaseConfig,
  app: AppConfig,
  opts: DatabaseModuleOptions<TSchema>,
  runtime: DrizzleDB<TSchema>,
): Promise<DrizzleDB<TSchema> | null> {
  try {
    return await createSystemDrizzleDatabase(cfg, app, opts);
  } catch (error) {
    await runtime.$client.end({ timeout: 0 });
    throw error;
  }
}

const resolveTransactionalOptions = (
  value: DatabaseModuleOptions['transactional'],
): DatabaseTransactionalOptions | null => {
  if (value === false) return null;
  return isObject(value) ? value : {};
};

/**
 * The transactional plugin is registered HERE (via `ClsModule.registerPlugins`) rather than in
 * `ClsModule.forRoot({ plugins })`, because `@platform/observability` owns `ClsModule.forRoot` and must
 * not know about Drizzle. The plugin module is global and resolves `DRIZZLE` through this global
 * module — never pass `DatabaseModule` in the plugin's `imports` (a second, option-less copy
 * would be instantiated; research data-libs GOTCHA 13). `TransactionHost` opens a CLS context by
 * itself when none is active, so `@Transactional()` also works in crons, consumers and CQRS
 * handlers.
 */
const transactionalPlugin = (options: DatabaseTransactionalOptions): ClsPluginTransactional =>
  new ClsPluginTransactional({
    adapter: new DrizzlePostgresTransactionalAdapter({
      drizzleInstanceToken: DRIZZLE,
      ...(options.defaultTxOptions === undefined
        ? {}
        : { defaultTxOptions: options.defaultTxOptions }),
    }),
    enableTransactionProxy: options.enableTransactionProxy ?? false,
  });

/**
 * PostgreSQL via postgres.js + Drizzle (global). Provides `DRIZZLE` (`@InjectDrizzle()`),
 * `TransactionHost` / `@Transactional()`, `RlsElevation` (elevation of a runtime transaction; it
 * asks the `PrincipalPermissions` that `RbacModule.forRoot()` binds), `SYSTEM_DATABASE`
 * (`SystemDatabase` over the app_system pool on DATABASE_SYSTEM_URL; inject it with
 * `@InjectSystemDatabase()`, from `*.system-repository.ts` files only) and
 * `DatabaseHealthIndicator` (register it with
 * `ObservabilityModule.forRoot({ healthContributors: [DatabaseHealthIndicator] })`).
 * Pool settings come from the `database` config namespace; `application_name` = SERVICE_NAME.
 * With `runMigrations` / DATABASE_RUN_MIGRATIONS, boot applies `platformMigrations` and then
 * `options.migrations` in order, under one advisory lock, before the pool opens.
 */
@Module({})
export class DatabaseModule {
  static forRootAsync<TSchema extends DrizzleSchema>(
    options: DatabaseModuleOptions<TSchema>,
  ): DynamicModule {
    // Checked when the module is defined, not at the first migrating boot: a set listed twice or a
    // shared bookkeeping table then fails every test that builds the app module.
    withPlatformMigrations(options.migrations);
    const transactional = resolveTransactionalOptions(options.transactional);
    return {
      module: DatabaseModule,
      global: true,
      imports: [
        ConfigModule.forFeature(databaseConfig),
        ConfigModule.forFeature(appConfig),
        TerminusModule,
        ...(transactional === null
          ? []
          : [ClsModule.registerPlugins([transactionalPlugin(transactional)])]),
      ],
      providers: [
        { provide: DATABASE_MODULE_OPTIONS, useValue: options },
        {
          provide: DRIZZLE,
          inject: [databaseConfig.KEY, appConfig.KEY, DATABASE_MODULE_OPTIONS],
          useFactory: (
            cfg: DatabaseConfig,
            app: AppConfig,
            opts: DatabaseModuleOptions<TSchema>,
          ): Promise<DrizzleDB<TSchema>> => createDrizzleDatabase(cfg, app, opts),
        },
        {
          provide: SYSTEM_POOL,
          inject: [databaseConfig.KEY, appConfig.KEY, DATABASE_MODULE_OPTIONS, DRIZZLE],
          useFactory: (
            cfg: DatabaseConfig,
            app: AppConfig,
            opts: DatabaseModuleOptions<TSchema>,
            runtime: DrizzleDB<TSchema>,
          ): Promise<DrizzleDB<TSchema> | null> => openSystemPool(cfg, app, opts, runtime),
        },
        {
          provide: SYSTEM_DATABASE,
          inject: [SYSTEM_POOL],
          useFactory: (db: DrizzleDB<TSchema> | null): SystemDatabase<TSchema> =>
            new SystemDatabase(db),
        },
        DatabaseLifecycle,
        DatabaseHealthIndicator,
        RlsElevation,
      ],
      // SYSTEM_POOL (the raw app_system handle) is never exported: SystemDatabase.run is the door.
      exports: [DRIZZLE, DatabaseHealthIndicator, RlsElevation, SYSTEM_DATABASE],
    };
  }
}
