import { type AppConfig, appConfig, type DatabaseConfig, databaseConfig } from '@app/config';
import {
  type DynamicModule,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { isObject } from 'lodash-es';
import { ClsModule } from 'nestjs-cls';
import type { DatabaseModuleOptions, DatabaseTransactionalOptions } from './database.types.js';
import { DATABASE_MODULE_OPTIONS, DRIZZLE } from './drizzle/drizzle.constants.js';
import { createDrizzleDatabase } from './drizzle/drizzle.factory.js';
import type { DrizzleDB, DrizzleSchema } from './drizzle/drizzle.types.js';
import { DrizzlePostgresTransactionalAdapter } from './drizzle/drizzle-transactional.adapter.js';
import { InjectDrizzle } from './drizzle/inject-drizzle.decorator.js';
import { DatabaseHealthIndicator } from './health/database.health.js';

/** How long `end()` lets in-flight queries finish on shutdown before destroying sockets. */
const POOL_END_TIMEOUT_SEC = 5;

/** Closes the pool when Nest shuts down (requires `app.enableShutdownHooks()`). */
@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger('DatabaseModule');

  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    await this.db.$client.end({ timeout: POOL_END_TIMEOUT_SEC });
    this.logger.log(`Postgres pool closed (${signal ?? 'shutdown'})`);
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
 * `ClsModule.forRoot({ plugins })`, because `@app/observability` owns `ClsModule.forRoot` and must
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
 * `TransactionHost` / `@Transactional()`, and `DatabaseHealthIndicator` (register it with
 * `ObservabilityModule.forRoot({ healthContributors: [DatabaseHealthIndicator] })`).
 * Pool settings come from the `database` config namespace; `application_name` = SERVICE_NAME.
 */
@Module({})
export class DatabaseModule {
  static forRootAsync<TSchema extends DrizzleSchema>(
    options: DatabaseModuleOptions<TSchema>,
  ): DynamicModule {
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
        DatabaseLifecycle,
        DatabaseHealthIndicator,
      ],
      exports: [DRIZZLE, DatabaseHealthIndicator],
    };
  }
}
