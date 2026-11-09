import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { billingGrpcClientConfig } from '@domain/billing';
import { filesConfig } from '@domain/files';
import { identityGrpcClientConfig } from '@domain/identity';
import { notificationsGrpcClientConfig, notificationsRateLimitConfig } from '@domain/notifications';
import { validateAllEnv } from '@platform/config';
import { describe, expect, it } from 'vitest';
import { gatewayConfig } from '../src/gateway.config.js';

/**
 * The domain and app-local namespaces the gateway loads besides the platform ones: the three
 * upstream targets (`XApiModule.forRemote()`), files' `files` (FilesModule) and its own `gateway`
 * (main.ts). It loads no `refreshToken`, `password` or `stripe` (see app.e2e-spec.ts).
 */
const NAMESPACES = [
  identityGrpcClientConfig,
  notificationsGrpcClientConfig,
  billingGrpcClientConfig,
  filesConfig,
  gatewayConfig,
  notificationsRateLimitConfig,
] as const;

/**
 * `.env.example` is what `bun run setup:env` copies to `.env`: it must stay valid for every config
 * namespace this app loads and point the gateway at the services' local gRPC ports (identity
 * 50051, notifications 50052, billing 50053) so `bun run dev:microservices` works out of the box.
 */
describe('gateway .env.example', () => {
  const env = parseEnv(readFileSync(join(import.meta.dirname, '..', '.env.example'), 'utf8'));

  it('passes every config namespace this service loads', () => {
    expect(() => validateAllEnv(env, NAMESPACES)).not.toThrow();
  });

  it('pins the app identity, port, push consumer group and upstream targets', () => {
    const config = validateAllEnv(env, NAMESPACES);
    expect(config.app).toMatchObject({ serviceName: 'gateway', port: 3000 });
    expect(config.kafka.groupId).toBe('gateway-push');
    expect(config.gateway.kafkaGroupId).toBe('gateway-push');
    expect(config.identityGrpcClient.url).toBe('localhost:50051');
    expect(config.notificationsGrpcClient.url).toBe('localhost:50052');
    expect(config.billingGrpcClient.url).toBe('localhost:50053');
    expect(config.grpc.deadlineMs).toBe(5000);
    expect(config).toHaveProperty('files');
  });
});
