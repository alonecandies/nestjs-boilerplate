import { grpcConfig } from '@app/config';
import { PROTO_DIR } from '@app/contracts';
import type { PackageDefinition } from '@grpc/proto-loader';
import { ServerGrpc, Transport } from '@nestjs/microservices';
import { describe, expect, it, vi } from 'vitest';
import { buildGrpcServiceConfig, createGrpcClientOptions } from './grpc-client.options.js';
import { GrpcHealthService, type HealthServer } from './grpc-health.js';
import {
  createGrpcServerOptions,
  createGrpcServerStrategy,
  HealthReportingGrpcServer,
} from './grpc-server.options.js';

const cfg = grpcConfig.parse({
  GRPC_URL: '0.0.0.0:6000',
  IDENTITY_GRPC_URL: 'dns:///identity:50051',
  GRPC_DEADLINE_MS: '2500',
  GRPC_MAX_MESSAGE_BYTES: '2097152',
});

interface MethodConfig {
  name: { service: string }[];
  timeout: { seconds: number; nanos: number };
  retryPolicy?: { maxAttempts: number; retryableStatusCodes: string[] };
}

describe('buildGrpcServiceConfig', () => {
  it('sets a real deadline, UNAVAILABLE retries and round_robin', () => {
    const config = buildGrpcServiceConfig(['identity.v1.AuthService'], { timeoutMs: 1500 });
    expect(config.loadBalancingConfig).toEqual([{ round_robin: {} }]);
    const [method] = config.methodConfig as MethodConfig[];
    expect(method?.name).toEqual([{ service: 'identity.v1.AuthService' }]);
    // Object form: grpc-js 1.14 misparses fractional strings such as '1.5s'.
    expect(method?.timeout).toEqual({ seconds: 1, nanos: 500_000_000 });
    expect(method?.retryPolicy).toMatchObject({
      maxAttempts: 3,
      retryableStatusCodes: ['UNAVAILABLE'],
    });
    expect(config.retryThrottling).toEqual({ maxTokens: 10, tokenRatio: 0.1 });
  });

  it('clamps attempts to the grpc-js maximum and can disable retries', () => {
    const clamped = buildGrpcServiceConfig(['s'], { timeoutMs: 100, maxAttempts: 99 });
    expect((clamped.methodConfig as MethodConfig[])[0]?.retryPolicy?.maxAttempts).toBe(5);
    const disabled = buildGrpcServiceConfig(['s'], { timeoutMs: 100, maxAttempts: 1 });
    expect((disabled.methodConfig as MethodConfig[])[0]?.retryPolicy).toBeUndefined();
  });
});

describe('createGrpcClientOptions', () => {
  it('targets the configured url with the shared loader, limits, keepalive and service config', () => {
    const { transport, options } = createGrpcClientOptions(cfg, 'identity');
    expect(transport).toBe(Transport.GRPC);
    expect(options).toMatchObject({
      url: 'dns:///identity:50051',
      package: ['identity.v1'],
      protoPath: ['identity/v1/identity.proto'],
      loader: {
        keepCase: false,
        longs: String,
        enums: String,
        defaults: true,
        includeDirs: [PROTO_DIR],
      },
      maxSendMessageLength: 2_097_152,
      maxReceiveMessageLength: 2_097_152,
      keepalive: { keepaliveTimeMs: 30_000, keepaliveTimeoutMs: 10_000 },
    });
    const channel = options.channelOptions ?? {};
    expect(channel['grpc.enable_retries']).toBe(1);
    expect(channel['grpc.service_config_disable_resolver']).toBe(1);
    const serviceConfig = JSON.parse(String(channel['grpc.service_config'])) as {
      methodConfig: MethodConfig[];
    };
    expect(serviceConfig.methodConfig[0]?.name).toEqual([
      { service: 'identity.v1.AuthService' },
      { service: 'identity.v1.UsersService' },
    ]);
    expect(serviceConfig.methodConfig[0]?.timeout).toEqual({ seconds: 2, nanos: 500_000_000 });
  });

  it('accepts per-registration deadline and channel overrides', () => {
    const { options } = createGrpcClientOptions(cfg, 'billing', {
      deadlineMs: 800,
      channelOptions: { 'grpc.max_reconnect_backoff_ms': 2_000 },
    });
    const channel = options.channelOptions ?? {};
    expect(channel['grpc.max_reconnect_backoff_ms']).toBe(2_000);
    expect(String(channel['grpc.service_config'])).toContain('"nanos":800000000');
  });
});

describe('createGrpcServerOptions', () => {
  it('binds every requested package with graceful shutdown and keepalive', () => {
    const { options } = createGrpcServerOptions(cfg, ['identity', 'billing', 'identity']);
    expect(options).toMatchObject({
      url: '0.0.0.0:6000',
      package: ['identity.v1', 'billing.v1'],
      protoPath: ['identity/v1/identity.proto', 'billing/v1/billing.proto'],
      gracefulShutdown: true,
      keepalive: { keepalivePermitWithoutCalls: 1, http2MinPingIntervalWithoutDataMs: 10_000 },
      channelOptions: { 'grpc.max_concurrent_streams': 1000 },
    });
  });

  it('returns fresh channel options each time (ServerGrpc mutates them)', () => {
    const a = createGrpcServerOptions(cfg, ['identity']).options.channelOptions;
    const b = createGrpcServerOptions(cfg, ['identity']).options.channelOptions;
    expect(a).not.toBe(b);
  });

  it('attaches health and reflection to the grpc-js server', () => {
    const health = new GrpcHealthService(['identity.v1.UsersService'], 'SERVING');
    const addService = vi.fn();
    const extra = vi.fn();
    const { options } = createGrpcServerOptions(cfg, ['identity'], {
      health,
      onLoadPackageDefinition: extra,
    });
    const server = { addService } as unknown as HealthServer;
    options.onLoadPackageDefinition?.({} satisfies PackageDefinition, server);

    const serviceNames = addService.mock.calls.map(
      ([definition]) => Object.values(definition as Record<string, { path: string }>)[0]?.path,
    );
    expect(serviceNames).toEqual(
      expect.arrayContaining([
        '/grpc.health.v1.Health/Check',
        '/grpc.reflection.v1.ServerReflection/ServerReflectionInfo',
      ]),
    );
    expect(extra).toHaveBeenCalledWith({}, server);
  });

  it('can disable reflection', () => {
    const addService = vi.fn();
    const { options } = createGrpcServerOptions(cfg, ['identity'], { reflection: false });
    options.onLoadPackageDefinition?.({}, { addService });
    expect(addService).toHaveBeenCalledTimes(1);
  });
});

describe('createGrpcServerStrategy / HealthReportingGrpcServer', () => {
  it('builds a ServerGrpc that keeps the gRPC transport id, NOT_SERVING until it listens', () => {
    const { strategy } = createGrpcServerStrategy(cfg, ['notifications']);
    expect(strategy).toBeInstanceOf(HealthReportingGrpcServer);
    expect(strategy).toBeInstanceOf(ServerGrpc);
    expect((strategy as HealthReportingGrpcServer).transportId).toBe(Transport.GRPC);
    const { health } = strategy as HealthReportingGrpcServer;
    expect(health.status).toBe('NOT_SERVING');
    expect(health.services).toEqual(['notifications.v1.NotificationsService']);
  });

  it('switches health to NOT_SERVING when closing', async () => {
    const health = new GrpcHealthService(['s'], 'SERVING');
    const server = new HealthReportingGrpcServer(
      createGrpcServerOptions(cfg, ['identity']).options,
      health,
    );
    await server.close();
    expect(health.status).toBe('NOT_SERVING');
  });
});
