import type { GrpcConfig } from '@app/config';
import { GRPC_LOADER_OPTIONS, type GrpcPackageName, resolveGrpcPackages } from '@app/contracts';
import type { ChannelOptions } from '@grpc/grpc-js';
import type { PackageDefinition } from '@grpc/proto-loader';
import { ReflectionService } from '@grpc/reflection';
import {
  type CustomStrategy,
  type GrpcOptions,
  ServerGrpc,
  Transport,
} from '@nestjs/microservices';
import { GRPC_KEEPALIVE } from './grpc.constants.js';
import { GrpcHealthService, type HealthServer } from './grpc-health.js';
import { createGrpcServerCredentials } from './grpc-tls.js';

/** Extra knobs for `createGrpcServerOptions` / `createGrpcServerStrategy`. */
export interface GrpcServerOptionsExtras {
  /** Health service to attach. Default: a new one, created SERVING (options) or NOT_SERVING (strategy). */
  health?: GrpcHealthService;
  /**
   * Expose gRPC server reflection (grpcurl, Postman, Kreya). Default `grpcConfig.reflection`
   * (`GRPC_REFLECTION`, else on unless `NODE_ENV=production`).
   */
  reflection?: boolean;
  /** Raw `grpc.*` channel options, merged over the defaults below. */
  channelOptions?: ChannelOptions;
  /** Extra hook after health and reflection are attached. */
  onLoadPackageDefinition?: (pkg: PackageDefinition, server: HealthServer) => void;
}

/**
 * Server channel defaults:
 * - `max_concurrent_streams` caps the number of in-flight calls per HTTP/2 connection.
 * - `max_connection_age` makes clients reconnect, and re-resolve DNS, every few minutes, so
 *   `round_robin` clients start using new replicas (a long-lived HTTP/2 connection otherwise
 *   pins them to the old ones). The grace period lets in-flight calls finish.
 */
const DEFAULT_SERVER_CHANNEL_OPTIONS: ChannelOptions = {
  'grpc.max_concurrent_streams': 1000,
  'grpc.max_connection_age_ms': 5 * 60_000,
  'grpc.max_connection_age_grace_ms': 30_000,
};

function isHealthServer(value: unknown): value is HealthServer {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { addService?: unknown }).addService === 'function'
  );
}

/**
 * `GrpcOptions` for a server hosting `packages`: bind address and message limits from
 * `grpcConfig`, proto-loader options that match the ts-proto codegen, keepalive,
 * `gracefulShutdown` (drain with `tryShutdown`), and `grpc.health.v1` plus reflection attached
 * through `onLoadPackageDefinition`. With `grpcConfig.tls` the server speaks TLS (mutual TLS when
 * `requireClientCert`); without it, plaintext with no caller authentication at all, so the port
 * must only be reachable by trusted callers (NetworkPolicy, mesh).
 *
 * Use it directly for a standalone `NestFactory.createMicroservice`. Hybrid apps use
 * `connectGrpcServer`, which also reports health around listen and close.
 */
export function createGrpcServerOptions(
  cfg: GrpcConfig,
  packages: readonly GrpcPackageName[],
  extras: GrpcServerOptionsExtras = {},
): GrpcOptions {
  const resolved = resolveGrpcPackages(packages);
  const health = extras.health ?? new GrpcHealthService(resolved.services, 'SERVING');
  const reflection = extras.reflection ?? cfg.reflection;
  const credentials = createGrpcServerCredentials(cfg.tls);
  return {
    transport: Transport.GRPC,
    options: {
      url: cfg.url,
      ...(credentials === undefined ? {} : { credentials }),
      package: resolved.packages,
      protoPath: resolved.protoPath,
      loader: { ...GRPC_LOADER_OPTIONS, includeDirs: [...GRPC_LOADER_OPTIONS.includeDirs] },
      maxSendMessageLength: cfg.maxMessageBytes,
      maxReceiveMessageLength: cfg.maxMessageBytes,
      keepalive: { ...GRPC_KEEPALIVE },
      // A fresh object on every call: ServerGrpc writes its message limits into this object.
      channelOptions: { ...DEFAULT_SERVER_CHANNEL_OPTIONS, ...extras.channelOptions },
      gracefulShutdown: true,
      onLoadPackageDefinition: (pkg: PackageDefinition, server: unknown): void => {
        // Nest calls this after the grpc-js Server is created and bound, before it registers the
        // application services.
        if (!isHealthServer(server)) return;
        health.addToServer(server);
        if (reflection) new ReflectionService(pkg).addToServer(server);
        extras.onLoadPackageDefinition?.(pkg, server);
      },
    },
  };
}

/**
 * `ServerGrpc` that also reports `grpc.health.v1` status: `SERVING` only once `listen()` has
 * registered every service, so a probe never passes while calls would still get
 * `UNIMPLEMENTED`. It switches to `NOT_SERVING` as soon as `close()` starts, so load balancers
 * stop routing while `tryShutdown()` drains in-flight calls.
 */
export class HealthReportingGrpcServer extends ServerGrpc {
  constructor(
    options: GrpcOptions['options'],
    readonly health: GrpcHealthService,
  ) {
    super(options);
  }

  override async listen(
    callback: (err?: unknown, ...optionalParams: unknown[]) => void,
  ): Promise<void> {
    await super.listen((err?: unknown, ...optionalParams: unknown[]) => {
      if (err === undefined || err === null) this.health.setStatus('SERVING');
      callback(err, ...optionalParams);
    });
  }

  override async close(): Promise<void> {
    this.health.setStatus('NOT_SERVING');
    await super.close();
  }
}

/**
 * Custom-strategy form of `createGrpcServerOptions` with a `HealthReportingGrpcServer`. Pass it
 * to `app.connectMicroservice()` or `NestFactory.createMicroservice()`. Handlers bind as usual,
 * because the server keeps `transportId = Transport.GRPC`.
 */
export function createGrpcServerStrategy(
  cfg: GrpcConfig,
  packages: readonly GrpcPackageName[],
  extras: GrpcServerOptionsExtras = {},
): CustomStrategy {
  const health =
    extras.health ?? new GrpcHealthService(resolveGrpcPackages(packages).services, 'NOT_SERVING');
  const { options } = createGrpcServerOptions(cfg, packages, { ...extras, health });
  return { strategy: new HealthReportingGrpcServer(options, health) };
}
