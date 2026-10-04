import { type GrpcConfig, grpcConfig } from '@app/config';
import { GRPC_PACKAGES, type GrpcPackageName } from '@app/contracts';
import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule, type GrpcOptions } from '@nestjs/microservices';
import { uniq } from 'lodash-es';
import { GRPC_CIRCUIT_BREAKER_OPTIONS } from './grpc.constants.js';
import { type GrpcCircuitBreakerOptions, GrpcCircuitBreakers } from './grpc-circuit-breakers.js';
import { createGrpcClientOptions, type GrpcClientOptionsExtras } from './grpc-client.options.js';

export interface GrpcClientsModuleOptions {
  /** Deadline, retry and channel tuning applied to every client of this registration. */
  client?: GrpcClientOptionsExtras;
  /** Overrides of `DEFAULT_GRPC_CIRCUIT_BREAKER_OPTIONS`. */
  breaker?: Partial<GrpcCircuitBreakerOptions>;
}

/**
 * Registers one `ClientGrpc` per package under `GRPC_PACKAGES[name].clientToken`
 * (`@Inject(GRPC_PACKAGES.identity.clientToken) client: ClientGrpc`). Clients are configured from
 * `grpcConfig`. Exports:
 * - the clients (closed automatically on application shutdown),
 * - `GrpcCircuitBreakers`,
 * - the `grpcConfig` namespace, so adapters can inject `grpcConfig.KEY` for `deadlineMs`.
 *
 * Channels connect lazily on the first call. Call `client.getService()` in `onModuleInit`.
 */
@Module({})
export class GrpcClientsModule {
  static register(
    packages: readonly GrpcPackageName[],
    options: GrpcClientsModuleOptions = {},
  ): DynamicModule {
    const configModule = ConfigModule.forFeature(grpcConfig);
    const clients = ClientsModule.registerAsync(
      uniq(packages).map((name) => ({
        name: GRPC_PACKAGES[name].clientToken,
        imports: [configModule],
        inject: [grpcConfig.KEY],
        useFactory: (cfg: GrpcConfig): GrpcOptions =>
          createGrpcClientOptions(cfg, name, options.client),
      })),
    );
    return {
      module: GrpcClientsModule,
      imports: [configModule, clients],
      providers: [
        { provide: GRPC_CIRCUIT_BREAKER_OPTIONS, useValue: options.breaker ?? {} },
        GrpcCircuitBreakers,
      ],
      exports: [clients, configModule, GrpcCircuitBreakers],
    };
  }
}
