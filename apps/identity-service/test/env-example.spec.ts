import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { validateAllEnv } from '@app/config';
import { describe, expect, it } from 'vitest';

/**
 * `.env.example` is what `bun run setup:env` copies to `.env`: it must stay valid for every config
 * namespace and keep this service off the ports of the other services (gateway 3000, notifications
 * 3002/50052, billing 3003/50053) so `bun run dev:microservices` works out of the box.
 */
describe('identity-service .env.example', () => {
  const env = parseEnv(readFileSync(join(import.meta.dirname, '..', '.env.example'), 'utf8'));

  it('passes every config namespace', () => {
    expect(() => validateAllEnv(env)).not.toThrow();
  });

  it('pins the service identity, ports and boot-time migrations', () => {
    const config = validateAllEnv(env);
    expect(config.app).toMatchObject({ serviceName: 'identity-service', port: 3001 });
    expect(config.grpc.url).toBe('0.0.0.0:50051');
    expect(config.kafka.groupId).toBe('identity-service');
    expect(config.database.runMigrations).toBe(true);
  });
});
