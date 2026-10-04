import type { GrpcConfig } from '@app/config';
import {
  GRPC_LOADER_OPTIONS,
  GRPC_PACKAGES,
  type GrpcPackageName,
  resolveGrpcPackages,
} from '@app/contracts';
import type { ChannelOptions, ServiceConfig } from '@grpc/grpc-js';
import { type GrpcOptions, Transport } from '@nestjs/microservices';
import { clamp } from 'lodash-es';
import { GRPC_KEEPALIVE } from './grpc.constants.js';

/** Per-client tuning for `createGrpcClientOptions` / `GrpcClientsModule.register`. */
export interface GrpcClientOptionsExtras {
  /** Per-call deadline sent to the server. Default `grpcConfig.deadlineMs`. */
  deadlineMs?: number;
  /** Total attempts (including the first) for `UNAVAILABLE`. Default 3; `1` disables retries. */
  maxAttempts?: number;
  /** Raw `grpc.*` channel options, merged over the defaults. */
  channelOptions?: ChannelOptions;
}

export interface GrpcServiceConfigOptions {
  timeoutMs: number;
  maxAttempts?: number;
}

/** grpc-js caps `retryPolicy.maxAttempts` at 5. */
const MAX_RETRY_ATTEMPTS = 5;

/**
 * Service config (gRFC A6) applied to every method of `services`:
 * - `timeout` is a real per-call deadline. The server sees it in `call.getDeadline()`, and grpc-js
 *   fails the call with `DEADLINE_EXCEEDED` even when nobody unsubscribes.
 * - `retryPolicy` transparently retries `UNAVAILABLE` (connection refused, server draining) with
 *   backoff. `retryThrottling` stops retries when most calls fail, so an outage is not amplified.
 * - `round_robin` spreads calls over every address the target resolves to (use a
 *   `dns:///svc.ns.svc.cluster.local:50051` target for a headless Kubernetes service).
 *
 * The timeout uses the `{ seconds, nanos }` object form: grpc-js 1.14 parses a fractional
 * string such as `'1.5s'` as 1 s + 5 ns.
 */
export function buildGrpcServiceConfig(
  services: readonly string[],
  options: GrpcServiceConfigOptions,
): ServiceConfig {
  const timeoutMs = Math.max(1, Math.round(options.timeoutMs));
  const maxAttempts = clamp(Math.round(options.maxAttempts ?? 3), 1, MAX_RETRY_ATTEMPTS);
  return {
    loadBalancingConfig: [{ round_robin: {} }],
    methodConfig: [
      {
        name: services.map((service) => ({ service })),
        timeout: { seconds: Math.floor(timeoutMs / 1000), nanos: (timeoutMs % 1000) * 1_000_000 },
        // grpc-js rejects a retryPolicy with maxAttempts < 2: omit it to disable retries.
        ...(maxAttempts >= 2
          ? {
              retryPolicy: {
                maxAttempts,
                initialBackoff: '0.1s',
                maxBackoff: '1s',
                backoffMultiplier: 2,
                retryableStatusCodes: ['UNAVAILABLE'],
              },
            }
          : {}),
      },
    ],
    retryThrottling: { maxTokens: 10, tokenRatio: 0.1 },
  };
}

/**
 * Client `GrpcOptions` for one package: target from `grpcConfig.clients[name]`, the same
 * proto-loader options as the server, message limits, keepalive (detects dead connections behind
 * NATs and load balancers), and the service config above. Resolver-supplied (DNS TXT) service
 * configs are disabled, so the config in code is the only one that applies.
 */
export function createGrpcClientOptions(
  cfg: GrpcConfig,
  name: GrpcPackageName,
  extras: GrpcClientOptionsExtras = {},
): GrpcOptions {
  const resolved = resolveGrpcPackages([name]);
  const serviceConfig = buildGrpcServiceConfig(resolved.services, {
    timeoutMs: extras.deadlineMs ?? cfg.deadlineMs,
    ...(extras.maxAttempts === undefined ? {} : { maxAttempts: extras.maxAttempts }),
  });
  return {
    transport: Transport.GRPC,
    options: {
      url: cfg.clients[name],
      package: resolved.packages,
      protoPath: [...GRPC_PACKAGES[name].protoPath],
      loader: { ...GRPC_LOADER_OPTIONS, includeDirs: [...GRPC_LOADER_OPTIONS.includeDirs] },
      maxSendMessageLength: cfg.maxMessageBytes,
      maxReceiveMessageLength: cfg.maxMessageBytes,
      keepalive: {
        keepaliveTimeMs: GRPC_KEEPALIVE.keepaliveTimeMs,
        keepaliveTimeoutMs: GRPC_KEEPALIVE.keepaliveTimeoutMs,
        keepalivePermitWithoutCalls: GRPC_KEEPALIVE.keepalivePermitWithoutCalls,
      },
      channelOptions: {
        'grpc.service_config': JSON.stringify(serviceConfig),
        'grpc.service_config_disable_resolver': 1,
        'grpc.enable_retries': 1,
        'grpc.initial_reconnect_backoff_ms': 1_000,
        'grpc.max_reconnect_backoff_ms': 10_000,
        ...extras.channelOptions,
      },
    },
  };
}
