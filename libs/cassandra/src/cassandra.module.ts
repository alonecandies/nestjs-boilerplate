import { type AppConfig, appConfig, type CassandraConfig, cassandraConfig } from '@app/config';
import {
  type DynamicModule,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import {
  CASSANDRA_CLIENT,
  CASSANDRA_MODULE_OPTIONS,
  InjectCassandra,
} from './cassandra.constants.js';
import type { CassandraClient, CassandraModuleOptions } from './cassandra.types.js';
import { createCassandraClient } from './client/create-cassandra-client.js';
import { CassandraHealthIndicator } from './health/cassandra.health.js';

/** Drains and closes every connection pool on shutdown (requires `app.enableShutdownHooks()`). */
@Injectable()
class CassandraLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger('CassandraModule');

  constructor(@InjectCassandra() private readonly client: CassandraClient) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    // In-flight requests complete first, then sockets close.
    await this.client.shutdown();
    this.logger.log(`Cassandra client closed (${signal ?? 'shutdown'})`);
  }
}

/**
 * Cassandra (global): provides the connected, keyspace-bound driver client as
 * `CASSANDRA_CLIENT` (`@InjectCassandra()`) and `CassandraHealthIndicator` (register it with
 * `ObservabilityModule.forRoot({ healthContributors: [CassandraHealthIndicator] })`).
 * With `CASSANDRA_RUN_MIGRATIONS` (default true) boot also creates the keyspace and applies the
 * given CQL migration folders — before any provider can inject the client.
 */
@Module({})
export class CassandraModule {
  static forRootAsync(options: CassandraModuleOptions = {}): DynamicModule {
    return {
      module: CassandraModule,
      global: true,
      imports: [
        ConfigModule.forFeature(cassandraConfig),
        ConfigModule.forFeature(appConfig),
        TerminusModule,
      ],
      providers: [
        { provide: CASSANDRA_MODULE_OPTIONS, useValue: options },
        {
          provide: CASSANDRA_CLIENT,
          inject: [cassandraConfig.KEY, appConfig.KEY, CASSANDRA_MODULE_OPTIONS],
          useFactory: (
            cfg: CassandraConfig,
            app: AppConfig,
            opts: CassandraModuleOptions,
          ): Promise<CassandraClient> => createCassandraClient(cfg, app, opts),
        },
        CassandraLifecycle,
        CassandraHealthIndicator,
      ],
      exports: [CASSANDRA_CLIENT, CassandraHealthIndicator],
    };
  }
}
