import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { passwordConfig, refreshTokenConfig, staffSwitchInConfig } from '@domain/identity';
import { validateAllEnv } from '@platform/config';
import { describe, expect, it } from 'vitest';

/**
 * `.env.example` is what `bun run setup:env` copies to `.env`: it must stay valid for every config
 * namespace this service loads (the platform ones, `outbox` among them, plus identity's
 * `password`, `refreshToken` and `staffSwitchIn`) and keep this service off the ports of the other
 * services (gateway 3000, notifications 3002/50052, billing 3003/50053) so
 * `bun run dev:microservices` works out of the box.
 */
describe('identity-service .env.example', () => {
  const env = parseEnv(readFileSync(join(import.meta.dirname, '..', '.env.example'), 'utf8'));

  it('passes every config namespace this service loads', () => {
    expect(() =>
      validateAllEnv(env, [passwordConfig, refreshTokenConfig, staffSwitchInConfig]),
    ).not.toThrow();
  });

  it('pins the service identity, ports and boot-time migrations', () => {
    const config = validateAllEnv(env, [passwordConfig, refreshTokenConfig, staffSwitchInConfig]);
    expect(config.app).toMatchObject({ serviceName: 'identity-service', port: 3001 });
    expect(config.observability.metricsPort).toBe(9465);
    expect(config.grpc.url).toBe('0.0.0.0:50051');
    expect(config.kafka.groupId).toBe('identity-service');
    expect(config.database.runMigrations).toBe(true);
    // identity's own namespaces (Argon2id cost, refresh tokens) are validated too.
    expect(config).toHaveProperty('password');
    expect(config).toHaveProperty('refreshToken');
    expect(config).toHaveProperty('staffSwitchIn');
    // identity.outbox's relay runs in this service.
    expect(config).toHaveProperty('outbox');
    expect(config.outbox.relayEnabled).toBe(true);
  });
});
