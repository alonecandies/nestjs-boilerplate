import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grpcConfig } from '@app/config';
import { PROTO_DIR } from '@app/contracts';
import { credentials, ServerCredentials } from '@grpc/grpc-js';
import type { PackageDefinition } from '@grpc/proto-loader';
import { ServerGrpc, Transport } from '@nestjs/microservices';
import { afterAll, describe, expect, it, vi } from 'vitest';
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
  name: { service: string; method?: string }[];
  timeout: { seconds: number; nanos: number };
  retryPolicy?: { maxAttempts: number; retryableStatusCodes: string[] };
}

/** The entry grpc-js picks for `service/method`: an exact method name beats a service-wide one. */
function configFor(methodConfig: MethodConfig[], service: string, method: string): MethodConfig {
  const exact = methodConfig.find(({ name }) =>
    name.some((n) => n.service === service && n.method === method),
  );
  const serviceWide = methodConfig.find(({ name }) =>
    name.some((n) => n.service === service && n.method === undefined),
  );
  const match = exact ?? serviceWide;
  if (match === undefined) throw new Error(`no method config for ${service}/${method}`);
  return match;
}

function serviceConfigOf(options: { channelOptions?: Record<string, unknown> }): {
  methodConfig: MethodConfig[];
} {
  return JSON.parse(String(options.channelOptions?.['grpc.service_config'])) as {
    methodConfig: MethodConfig[];
  };
}

const READ = { service: 'identity.v1.UsersService', method: 'GetUser' };

describe('buildGrpcServiceConfig', () => {
  it('sets a real deadline on every method, round_robin and retry throttling', () => {
    const config = buildGrpcServiceConfig(['identity.v1.AuthService'], { timeoutMs: 1500 });
    expect(config.loadBalancingConfig).toEqual([{ round_robin: {} }]);
    const [method, ...rest] = config.methodConfig as MethodConfig[];
    expect(rest).toEqual([]);
    expect(method?.name).toEqual([{ service: 'identity.v1.AuthService' }]);
    // Object form: grpc-js 1.14 misparses fractional strings such as '1.5s'.
    expect(method?.timeout).toEqual({ seconds: 1, nanos: 500_000_000 });
    // No retryable methods given: nothing is retried.
    expect(method?.retryPolicy).toBeUndefined();
    expect(config.retryThrottling).toEqual({ maxTokens: 10, tokenRatio: 0.1 });
  });

  it('retries UNAVAILABLE only for the retryable methods of the configured services', () => {
    const config = buildGrpcServiceConfig(['identity.v1.UsersService'], {
      timeoutMs: 1500,
      retryableMethods: [READ, { service: 'other.v1.Unknown', method: 'Get' }],
    });
    const methods = config.methodConfig as MethodConfig[];
    expect(configFor(methods, READ.service, READ.method)).toMatchObject({
      name: [READ],
      timeout: { seconds: 1, nanos: 500_000_000 },
      retryPolicy: { maxAttempts: 3, retryableStatusCodes: ['UNAVAILABLE'] },
    });
    expect(configFor(methods, READ.service, 'UpdateUserRoles').retryPolicy).toBeUndefined();
  });

  it('clamps attempts to the grpc-js maximum and can disable retries', () => {
    const clamped = buildGrpcServiceConfig([READ.service], {
      timeoutMs: 100,
      maxAttempts: 99,
      retryableMethods: [READ],
    });
    const clampedMethods = clamped.methodConfig as MethodConfig[];
    expect(configFor(clampedMethods, READ.service, READ.method).retryPolicy?.maxAttempts).toBe(5);
    const disabled = buildGrpcServiceConfig([READ.service], {
      timeoutMs: 100,
      maxAttempts: 1,
      retryableMethods: [READ],
    });
    for (const entry of disabled.methodConfig as MethodConfig[]) {
      expect(entry.retryPolicy).toBeUndefined();
    }
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
    const { methodConfig } = serviceConfigOf(options);
    const auth = configFor(methodConfig, 'identity.v1.AuthService', 'Login');
    expect(auth.name).toEqual([
      { service: 'identity.v1.AuthService' },
      { service: 'identity.v1.UsersService' },
    ]);
    expect(auth.timeout).toEqual({ seconds: 2, nanos: 500_000_000 });
  });

  it.each([
    ['identity', 'identity.v1.AuthService', 'Register'],
    ['identity', 'identity.v1.AuthService', 'Login'],
    ['identity', 'identity.v1.AuthService', 'RefreshTokens'],
    ['identity', 'identity.v1.AuthService', 'Logout'],
    ['identity', 'identity.v1.UsersService', 'UpdateUserRoles'],
    ['notifications', 'notifications.v1.NotificationsService', 'MarkNotificationRead'],
    ['billing', 'billing.v1.BillingService', 'CreateCheckoutSession'],
    ['billing', 'billing.v1.BillingService', 'HandleStripeWebhook'],
  ] as const)(
    'never retries the %s mutation %s/%s (a replay would repeat its side effect)',
    (name, service, method) => {
      const { methodConfig } = serviceConfigOf(createGrpcClientOptions(cfg, name).options);
      const entry = configFor(methodConfig, service, method);
      expect(entry.retryPolicy).toBeUndefined();
      expect(entry.timeout).toEqual({ seconds: 2, nanos: 500_000_000 });
    },
  );

  it.each([
    ['identity', 'identity.v1.UsersService', 'GetUser'],
    ['identity', 'identity.v1.UsersService', 'GetUsersByIds'],
    ['identity', 'identity.v1.UsersService', 'ListUsers'],
    ['notifications', 'notifications.v1.NotificationsService', 'ListNotifications'],
    ['billing', 'billing.v1.BillingService', 'ListPayments'],
  ] as const)('retries UNAVAILABLE for the %s read %s/%s', (name, service, method) => {
    const { methodConfig } = serviceConfigOf(createGrpcClientOptions(cfg, name).options);
    expect(configFor(methodConfig, service, method)).toMatchObject({
      timeout: { seconds: 2, nanos: 500_000_000 },
      retryPolicy: { maxAttempts: 3, retryableStatusCodes: ['UNAVAILABLE'] },
    });
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

  it('turns reflection off by default in production', () => {
    const production = grpcConfig.parse({ NODE_ENV: 'production', GRPC_ALLOW_INSECURE: 'true' });
    const addService = vi.fn();
    createGrpcServerOptions(production, ['identity']).options.onLoadPackageDefinition?.(
      {},
      { addService },
    );
    expect(addService).toHaveBeenCalledTimes(1); // health only

    const optedIn = grpcConfig.parse({
      NODE_ENV: 'production',
      GRPC_ALLOW_INSECURE: 'true',
      GRPC_REFLECTION: 'true',
    });
    const withReflection = vi.fn();
    createGrpcServerOptions(optedIn, ['identity']).options.onLoadPackageDefinition?.(
      {},
      { addService: withReflection },
    );
    expect(withReflection.mock.calls.length).toBeGreaterThan(1); // health + reflection
  });

  it('binds plaintext (no credentials) without TLS config', () => {
    expect(createGrpcServerOptions(cfg, ['identity']).options).not.toHaveProperty('credentials');
    expect(createGrpcClientOptions(cfg, 'identity').options).not.toHaveProperty('credentials');
  });
});

describe('gRPC TLS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grpc-tls-'));
  const pem = (name: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `-----${name}-----`);
    return path;
  };
  const tlsCfg = grpcConfig.parse({
    NODE_ENV: 'production',
    GRPC_TLS_CA_PATH: pem('ca.pem'),
    GRPC_TLS_CERT_PATH: pem('cert.pem'),
    GRPC_TLS_KEY_PATH: pem('key.pem'),
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('serves mutual TLS: own cert + key, client certificates verified against the CA', () => {
    const sentinel = ServerCredentials.createInsecure();
    const createSsl = vi.spyOn(ServerCredentials, 'createSsl').mockReturnValue(sentinel);

    const { options } = createGrpcServerOptions(tlsCfg, ['identity']);

    expect(options.credentials).toBe(sentinel);
    expect(createSsl).toHaveBeenCalledWith(
      Buffer.from('-----ca.pem-----'),
      [
        {
          cert_chain: Buffer.from('-----cert.pem-----'),
          private_key: Buffer.from('-----key.pem-----'),
        },
      ],
      true,
    );
    createSsl.mockRestore();
  });

  it('dials with TLS, verifying the server against the CA and presenting its own certificate', () => {
    const sentinel = credentials.createInsecure();
    const createSsl = vi.spyOn(credentials, 'createSsl').mockReturnValue(sentinel);

    const { options } = createGrpcClientOptions(tlsCfg, 'billing');

    expect(options.credentials).toBe(sentinel);
    expect(createSsl).toHaveBeenCalledWith(
      Buffer.from('-----ca.pem-----'),
      Buffer.from('-----key.pem-----'),
      Buffer.from('-----cert.pem-----'),
    );
    createSsl.mockRestore();
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
