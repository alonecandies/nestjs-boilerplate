import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { validateAllEnv } from '@app/config';
import { describe, expect, it } from 'vitest';
import { NOTIFICATIONS_CONSUMER_GROUP } from '../src/notifications-service.constants.js';

/**
 * `.env.example` is what `bun run setup:env` copies to `.env`: it must stay valid for every config
 * namespace and keep this service off the ports of the other services (gateway 3000, identity
 * 3001/50051, billing 3003/50053) so `bun run dev:microservices` works out of the box.
 */
describe('notifications-service .env.example', () => {
  const env = parseEnv(readFileSync(join(import.meta.dirname, '..', '.env.example'), 'utf8'));

  it('passes every config namespace', () => {
    expect(() => validateAllEnv(env)).not.toThrow();
  });

  it('pins the service identity, ports and consumer group', () => {
    const config = validateAllEnv(env);
    expect(config.app).toMatchObject({ serviceName: 'notifications-service', port: 3002 });
    expect(config.grpc.url).toBe('0.0.0.0:50052');
    expect(config.kafka.groupId).toBe(NOTIFICATIONS_CONSUMER_GROUP);
    expect(config.cassandra.runMigrations).toBe(true);
  });
});
