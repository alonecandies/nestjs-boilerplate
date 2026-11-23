import type { ChannelOptions, RetryPolicy, ServiceConfig } from '@grpc/grpc-js';
import { type GrpcOptions, Transport } from '@nestjs/microservices';
import type { GrpcConfig } from '@platform/config';
import {
  GRPC_LOADER_OPTIONS,
  type GrpcMethodName,
  type GrpcPackageSpec,
  resolveGrpcPackages,
} from '@platform/contracts';
import { clamp } from 'lodash-es';
import { GRPC_KEEPALIVE } from './grpc.constants.js';
import { createGrpcChannelCredentials } from './grpc-tls.js';

/** The package a client calls and where it dials it. */
export interface GrpcClientTarget {
  /** The package's spec, exported by the owning domain's contracts package. */
  readonly spec: GrpcPackageSpec;
  /** grpc-js target: `host:port`, `dns:///svc.ns.svc.cluster.local:50051`, … */
  readonly url: string;
}

/** Per-client tuning for `createGrpcClientOptions` / `GrpcClientsModule.register`. */
export interface GrpcClientOptionsExtras {
  /** Per-call deadline sent to the server. Default `grpcConfig.deadlineMs`. */
  deadlineMs?: number;
  /**
   * Methods whose deadline differs from `deadlineMs` (fully-qualified service plus proto method
   * name: `{ service: 'billing.v1.BillingService', method: 'CreateCheckoutSession', deadlineMs }`).
   * Every other method keeps `deadlineMs`.
   */
  methodDeadlines?: readonly GrpcMethodDeadline[];
  /**
   * Total attempts (including the first) on `UNAVAILABLE`, for the package's idempotent methods
   * only (`spec.idempotentMethods`). Default 3; `1` disables retries.
   */
  maxAttempts?: number;
  /** Raw `grpc.*` channel options, merged over the defaults. */
  channelOptions?: ChannelOptions;
}

/** A method whose deadline overrides the client's default one. */
type GrpcMethodDeadline = GrpcMethodName & { readonly deadlineMs: number };

export interface GrpcServiceConfigOptions {
  /** Deadline of every method without its own entry in `methodDeadlines`. */
  timeoutMs: number;
  maxAttempts?: number;
  /** The only methods that get the `retryPolicy`. Default none: nothing is retried. */
  retryableMethods?: readonly GrpcMethodName[];
  /** Methods with their own deadline. Default none: every method gets `timeoutMs`. */
  methodDeadlines?: readonly GrpcMethodDeadline[];
}

/** grpc-js caps `retryPolicy.maxAttempts` at 5. */
const MAX_RETRY_ATTEMPTS = 5;

/**
 * Service config (gRFC A6) for `services`:
 * - `timeout` is a real per-call deadline on every method: `timeoutMs`, or the method's own entry
 *   in `methodDeadlines`. The server sees it in `call.getDeadline()`, and grpc-js fails the call
 *   with `DEADLINE_EXCEEDED` even when nobody unsubscribes.
 * - `retryPolicy` retries `UNAVAILABLE` (connection refused, server draining) with backoff, but
 *   ONLY for `retryableMethods`: a `{ service, method }` entry beats the service-wide one in
 *   grpc-js. A server can commit a mutation and then die before answering, which the client also
 *   sees as `UNAVAILABLE`; replaying `RefreshTokens` would then trip refresh-token reuse detection
 *   and revoke every session of the user. grpc-js' own transparent retry of calls that never
 *   reached a server stays on for every method (it cannot duplicate side effects).
 * - `retryThrottling` stops retries when most calls fail, so an outage is not amplified.
 * - `round_robin` spreads calls over every address the target resolves to (use a
 *   `dns:///svc.ns.svc.cluster.local:50051` target for a headless Kubernetes service).
 *
 * Methods and services of other packages are ignored. A method is named in one entry only (grpc-js
 * rejects a duplicate name): a retryable method with its own deadline gets both in one entry.
 * The timeout uses the `{ seconds, nanos }` object form: grpc-js 1.14 parses a fractional
 * string such as `'1.5s'` as 1 s + 5 ns.
 */
export function buildGrpcServiceConfig(
  services: readonly string[],
  options: GrpcServiceConfigOptions,
): ServiceConfig {
  const maxAttempts = clamp(Math.round(options.maxAttempts ?? 3), 1, MAX_RETRY_ATTEMPTS);
  const knownServices = new Set(services);
  const known = ({ service }: GrpcMethodName): boolean => knownServices.has(service);
  const key = ({ service, method }: GrpcMethodName): string => `${service}/${method}`;
  const deadlines = new Map(
    (options.methodDeadlines ?? [])
      .filter(known)
      .map((entry) => [key(entry), entry.deadlineMs] as const),
  );
  // grpc-js rejects a retryPolicy with maxAttempts < 2.
  const retryable = maxAttempts >= 2 ? (options.retryableMethods ?? []).filter(known) : [];
  // The exact entries, one per (deadline, retried) pair; an exact name beats the service-wide one.
  const exact = new Map<string, { name: GrpcMethodName[]; timeoutMs: number; retried: boolean }>();
  const named = new Set<string>();
  const add = ({ service, method }: GrpcMethodName, retried: boolean): void => {
    const name = key({ service, method });
    if (named.has(name)) return;
    named.add(name);
    const timeoutMs = deadlines.get(name) ?? options.timeoutMs;
    const group = `${timeoutMs}/${retried}`;
    const entry = exact.get(group) ?? { name: [], timeoutMs, retried };
    entry.name.push({ service, method });
    exact.set(group, entry);
  };
  for (const name of retryable) add(name, true);
  for (const entry of options.methodDeadlines ?? []) {
    if (known(entry)) add(entry, false);
  }
  const methodConfig: ServiceConfig['methodConfig'] = [...exact.values()].map(
    ({ name, timeoutMs, retried }) => ({
      name,
      timeout: grpcTimeout(timeoutMs),
      ...(retried ? { retryPolicy: retryPolicy(maxAttempts) } : {}),
    }),
  );
  methodConfig.push({
    name: services.map((service) => ({ service })),
    timeout: grpcTimeout(options.timeoutMs),
  });
  return {
    loadBalancingConfig: [{ round_robin: {} }],
    methodConfig,
    retryThrottling: { maxTokens: 10, tokenRatio: 0.1 },
  };
}

/** A service-config `timeout` of at least 1 ms, in the `{ seconds, nanos }` form. */
function grpcTimeout(ms: number): { seconds: number; nanos: number } {
  const timeoutMs = Math.max(1, Math.round(ms));
  return { seconds: Math.floor(timeoutMs / 1000), nanos: (timeoutMs % 1000) * 1_000_000 };
}

/** Retries `UNAVAILABLE` with backoff, `maxAttempts` attempts in all (2-5). */
function retryPolicy(maxAttempts: number): RetryPolicy {
  return {
    maxAttempts,
    initialBackoff: '0.1s',
    maxBackoff: '1s',
    backoffMultiplier: 2,
    retryableStatusCodes: ['UNAVAILABLE'],
  };
}

/**
 * Client `GrpcOptions` for one package: dials `target.url` with the same proto-loader options as
 * the server, message limits, keepalive (detects dead connections behind NATs and load
 * balancers), and the service config above. Resolver-supplied (DNS TXT) service configs are
 * disabled, so the config in code is the only one that applies. With `grpcConfig.tls` the channel
 * uses TLS and presents this process's certificate (mutual TLS).
 */
export function createGrpcClientOptions(
  cfg: GrpcConfig,
  target: GrpcClientTarget,
  extras: GrpcClientOptionsExtras = {},
): GrpcOptions {
  const resolved = resolveGrpcPackages([target.spec]);
  const serviceConfig = buildGrpcServiceConfig(resolved.services, {
    timeoutMs: extras.deadlineMs ?? cfg.deadlineMs,
    retryableMethods: resolved.idempotentMethods,
    ...(extras.methodDeadlines === undefined ? {} : { methodDeadlines: extras.methodDeadlines }),
    ...(extras.maxAttempts === undefined ? {} : { maxAttempts: extras.maxAttempts }),
  });
  const credentials = createGrpcChannelCredentials(cfg.tls);
  return {
    transport: Transport.GRPC,
    options: {
      url: target.url,
      ...(credentials === undefined ? {} : { credentials }),
      package: resolved.packages,
      protoPath: resolved.protoPath,
      loader: { ...GRPC_LOADER_OPTIONS, includeDirs: resolved.includeDirs },
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
