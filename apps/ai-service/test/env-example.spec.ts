import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { billingGrpcClientConfig } from '@domain/billing/api';
import { identityGrpcClientConfig } from '@domain/identity/api';
import { notificationsGrpcClientConfig } from '@domain/notifications/api';
import { validateAllEnv } from '@platform/config';
import { describe, expect, it } from 'vitest';

/** The upstream targets of the chat tools (`AiToolSourcesModule`), besides the platform ones. */
const NAMESPACES = [
  identityGrpcClientConfig,
  notificationsGrpcClientConfig,
  billingGrpcClientConfig,
] as const;

/**
 * `.env.example` is what `bun run setup:env` copies to `.env`: it must stay valid for every config
 * namespace this service loads (the platform ones, `ai` among them, plus the tools' upstream targets)
 * and keep this service off the ports of the other services (gateway 3000, identity 3001/50051,
 * notifications 3002/50052, billing 3003/50053) so `bun run dev:microservices` works out of the box.
 */
describe('ai-service .env.example', () => {
  const env = parseEnv(readFileSync(join(import.meta.dirname, '..', '.env.example'), 'utf8'));

  it('passes every config namespace this service loads', () => {
    expect(() => validateAllEnv(env, NAMESPACES)).not.toThrow();
  });

  it('pins the service identity, ports, boot-time migrations and the tool upstreams', () => {
    const config = validateAllEnv(env, NAMESPACES);
    expect(config.app).toMatchObject({ serviceName: 'ai-service', port: 3004 });
    expect(config.observability.metricsPort).toBe(9468);
    expect(config.grpc.url).toBe('0.0.0.0:50054');
    expect(config.database.runMigrations).toBe(true);
    expect(config.identityGrpcClient.url).toBe('localhost:50051');
    expect(config.notificationsGrpcClient.url).toBe('localhost:50052');
    expect(config.billingGrpcClient.url).toBe('localhost:50053');
    // Off by default: every turn answers AI_DISABLED and nothing calls OpenRouter.
    expect(config.ai.enabled).toBe(false);
  });
});
