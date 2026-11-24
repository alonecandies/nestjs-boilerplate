import { type DynamicModule, Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule, type GrpcOptions } from '@nestjs/microservices';
import { type GrpcConfig, grpcConfig } from '@platform/config';
import { GRPC_CIRCUIT_BREAKER_OPTIONS } from './grpc.constants.js';
import { type GrpcCircuitBreakerOptions, GrpcCircuitBreakers } from './grpc-circuit-breakers.js';
import {
  createGrpcClientOptions,
  type GrpcClientOptionsExtras,
  type GrpcClientTarget,
} from './grpc-client.options.js';
import { applyPrincipalAssertionConfig } from './grpc-principal-assertion.js';

export interface GrpcClientsModuleOptions {
  /** Deadline, retry and channel tuning of this client (one client per registration). */
  client?: GrpcClientOptionsExtras;
  /** Overrides of `DEFAULT_GRPC_CIRCUIT_BREAKER_OPTIONS`. */
  breaker?: Partial<GrpcCircuitBreakerOptions>;
}

/**
 * Hands the injected `grpc` namespace to the principal assertion settings at module init, so the
 * signing key this process signs with is built at boot from the configuration the app validated: a
 * key `createPrivateKey` or `createPublicKey` refuses stops the boot, never the first call.
 */
@Injectable()
class GrpcPrincipalAssertionConfigLoader implements OnModuleInit {
  constructor(@Inject(grpcConfig.KEY) private readonly cfg: GrpcConfig) {}

  onModuleInit(): void {
    applyPrincipalAssertionConfig(this.cfg.principalAssertion);
  }
}

/**
 * Registers the `ClientGrpc` of one package under `spec.clientToken`
 * (`@Inject(ORDERS_GRPC_PACKAGE.clientToken) client: ClientGrpc`), dialing `url`. Deadline, TLS,
 * message limits and keepalive come from `grpcConfig`. Exports:
 * - the clients (closed automatically on application shutdown),
 * - `GrpcCircuitBreakers`,
 * - the `grpcConfig` namespace, so adapters can inject `grpcConfig.KEY` for `deadlineMs`.
 *
 * At module init it builds the principal assertion settings from that namespace
 * (`applyPrincipalAssertionConfig`): a bad signing or public key fails the boot.
 *
 * Channels connect lazily on the first call. Call `client.getService()` in `onModuleInit`.
 */
@Module({})
export class GrpcClientsModule {
  static register(target: GrpcClientTarget, options: GrpcClientsModuleOptions = {}): DynamicModule {
    const configModule = ConfigModule.forFeature(grpcConfig);
    const clients = ClientsModule.registerAsync([
      {
        name: target.spec.clientToken,
        imports: [configModule],
        inject: [grpcConfig.KEY],
        useFactory: (cfg: GrpcConfig): GrpcOptions =>
          createGrpcClientOptions(cfg, target, options.client),
      },
    ]);
    return {
      module: GrpcClientsModule,
      imports: [configModule, clients],
      providers: [
        { provide: GRPC_CIRCUIT_BREAKER_OPTIONS, useValue: options.breaker ?? {} },
        GrpcCircuitBreakers,
        GrpcPrincipalAssertionConfigLoader,
      ],
      exports: [clients, configModule, GrpcCircuitBreakers],
    };
  }
}
