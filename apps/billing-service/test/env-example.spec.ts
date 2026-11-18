import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { stripeConfig } from '@domain/billing';
import { validateAllEnv } from '@platform/config';
import { describe, expect, it } from 'vitest';

/**
 * `.env.example` is what `bun run setup:env` copies to `.env`: it must stay valid for every config
 * namespace this service loads (the platform ones, `outbox` among them, plus billing's `stripe`)
 * and keep this service off the ports of the other services (gateway 3000, identity 3001/50051,
 * notifications 3002/50052) so `bun run dev:microservices` works out of the box.
 */
describe('billing-service .env.example', () => {
  const env = parseEnv(readFileSync(join(import.meta.dirname, '..', '.env.example'), 'utf8'));

  it('passes every config namespace this service loads', () => {
    expect(() => validateAllEnv(env, [stripeConfig])).not.toThrow();
  });

  it('pins the service identity, ports and boot-time migrations', () => {
    const config = validateAllEnv(env, [stripeConfig]);
    expect(config.app).toMatchObject({ serviceName: 'billing-service', port: 3003 });
    expect(config.observability.metricsPort).toBe(9467);
    expect(config.grpc.url).toBe('0.0.0.0:50053');
    expect(config.kafka.groupId).toBe('billing-service');
    expect(config.database.runMigrations).toBe(true);
    expect(config).toHaveProperty('stripe');
    // billing.outbox's relay runs in this service.
    expect(config).toHaveProperty('outbox');
    expect(config.outbox.relayEnabled).toBe(true);
  });
});
