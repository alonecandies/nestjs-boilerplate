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
import { type ImmudbConfig, immudbConfig } from '@platform/config';
import { createImmudbGrpcClient } from './client/create-immudb-grpc-client.js';
import { GrpcImmudbClient } from './client/grpc-immudb.client.js';
import { ImmudbClient } from './client/immudb.client.js';
import { ImmudbSession } from './client/immudb-session.js';
import { ImmudbSessionPool } from './client/session-pool.js';
import type { ImmuServiceClient } from './generated/immudb/schema/schema.pb.js';
import { ImmudbHealthIndicator } from './health/immudb.health.js';
import { IMMUDB_GRPC_CLIENT, IMMUDB_MODULE_OPTIONS } from './immudb.constants.js';
import type { ImmudbModuleOptions } from './immudb.types.js';
import { runImmudbMigrations } from './migrations/immudb-migrations.js';

@Injectable()
class ImmudbLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger('ImmudbModule');

  constructor(
    private readonly pool: ImmudbSessionPool,
    @Inject(IMMUDB_GRPC_CLIENT) private readonly grpc: ImmuServiceClient,
  ) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    await this.pool.close();
    this.grpc.close();
    this.logger.log(`immudb sessions closed (${signal ?? 'shutdown'})`);
  }
}

/**
 * immudb (global): `ImmudbClient` (inject the class) and `ImmudbHealthIndicator` (register it with
 * `ObservabilityModule.forRoot({ healthContributors: [ImmudbHealthIndicator] })`).
 */
@Module({})
export class ImmudbModule {
  static forRootAsync(options: ImmudbModuleOptions = {}): DynamicModule {
    return {
      module: ImmudbModule,
      global: true,
      imports: [ConfigModule.forFeature(immudbConfig), TerminusModule],
      providers: [
        { provide: IMMUDB_MODULE_OPTIONS, useValue: options },
        {
          provide: IMMUDB_GRPC_CLIENT,
          inject: [immudbConfig.KEY],
          useFactory: (cfg: ImmudbConfig): ImmuServiceClient => createImmudbGrpcClient(cfg),
        },
        {
          provide: ImmudbSessionPool,
          inject: [IMMUDB_GRPC_CLIENT, immudbConfig.KEY, IMMUDB_MODULE_OPTIONS],
          useFactory: async (
            grpc: ImmuServiceClient,
            cfg: ImmudbConfig,
            opts: ImmudbModuleOptions,
          ): Promise<ImmudbSessionPool> => {
            // Before any provider can inject the client (like CassandraModule's boot migrations).
            if (opts.runMigrations ?? cfg.runMigrations) {
              await runImmudbMigrations(cfg, opts.migrations ?? [], { grpc });
            }
            return new ImmudbSessionPool(
              () =>
                ImmudbSession.open(
                  grpc,
                  { ...cfg.credentials, database: cfg.database },
                  cfg.timeoutMs,
                ),
              cfg.sessionPoolSize,
              cfg.keepAliveIntervalMs,
            );
          },
        },
        {
          provide: ImmudbClient,
          inject: [ImmudbSessionPool, immudbConfig.KEY],
          useFactory: (pool: ImmudbSessionPool, cfg: ImmudbConfig): ImmudbClient =>
            new GrpcImmudbClient(pool, {
              serverSigningPublicKeyPem: cfg.serverSigningPublicKeyPem,
            }),
        },
        ImmudbLifecycle,
        ImmudbHealthIndicator,
      ],
      exports: [ImmudbClient, ImmudbHealthIndicator],
    };
  }
}
