import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { stripeConfig } from '@domain/billing';
import { filesConfig } from '@domain/files';
import {
  identityRateLimitConfig,
  passwordConfig,
  refreshTokenConfig,
  staffSwitchInConfig,
} from '@domain/identity';
import { notificationsRateLimitConfig } from '@domain/notifications';
import { validateAllEnv } from '@platform/config';
import { describe, expect, it } from 'vitest';
import { monolithConfig } from '../src/monolith.config.js';

/**
 * The domain and app-local namespaces the monolith loads besides the platform ones: billing's
 * `stripe` (BillingCoreModule), identity's `password`, `refreshToken` and `staffSwitchIn` (IdentityCoreModule),
 * files' `files` (FilesModule) and its own `monolith` (main.ts).
 */
const NAMESPACES = [
  stripeConfig,
  passwordConfig,
  refreshTokenConfig,
  staffSwitchInConfig,
  filesConfig,
  monolithConfig,
  notificationsRateLimitConfig,
  identityRateLimitConfig,
] as const;

/**
 * `.env.example` is what `bun run setup:env` copies to `.env`: it must stay valid for every config
 * namespace this app loads, including the secret-bearing domain namespaces only it and the
 * services hold, and keep the port and consumer group the docs promise.
 */
describe('monolith .env.example', () => {
  const env = parseEnv(readFileSync(join(import.meta.dirname, '..', '.env.example'), 'utf8'));

  it('passes every config namespace this service loads', () => {
    expect(() => validateAllEnv(env, NAMESPACES)).not.toThrow();
  });

  it('pins the app identity, port, consumer group and boot-time migrations', () => {
    const config = validateAllEnv(env, NAMESPACES);
    expect(config.app).toMatchObject({ serviceName: 'monolith', port: 3000 });
    expect(config.observability.metricsPort).toBe(9464);
    expect(config.kafka.groupId).toBe('monolith');
    expect(config.monolith.kafkaGroupId).toBe('monolith');
    expect(config.database.runMigrations).toBe(true);
    expect(config.cassandra.runMigrations).toBe(true);
    for (const namespace of ['stripe', 'password', 'refreshToken', 'files']) {
      expect(config).toHaveProperty(namespace);
    }
  });
});
