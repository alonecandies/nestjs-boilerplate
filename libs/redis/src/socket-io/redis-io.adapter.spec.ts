import { createServer } from 'node:http';
import { redisConfig } from '@app/config';
import type { INestApplicationContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RedisIoAdapter } from './redis-io.adapter.js';

// A plain (never listening) http.Server stands in for Nest's Fastify server.
const asApp = (server: ReturnType<typeof createServer>): INestApplicationContext =>
  server as unknown as INestApplicationContext;

describe('RedisIoAdapter', () => {
  const config = redisConfig.parse({ REDIS_KEY_PREFIX: 'svc', REDIS_CONNECT_TIMEOUT_MS: '300' });

  it('applies throughput defaults, adapter overrides, then gateway options', async () => {
    const adapter = new RedisIoAdapter(asApp(createServer()), config, {
      serverOptions: { pingInterval: 10_000 },
    });
    const server = adapter.createIOServer(0, { path: '/ws', pingTimeout: 5_000 } as never);
    try {
      expect(server.engine.opts).toMatchObject({
        transports: ['websocket'],
        perMessageDeflate: false,
        pingInterval: 10_000,
        pingTimeout: 5_000,
        maxHttpBufferSize: 1_000_000,
      });
      expect(server.path()).toBe('/ws');
    } finally {
      await adapter.close(server);
      await adapter.dispose();
    }
  });

  it('fails fast (and cleans up) when Redis is unreachable', async () => {
    const unreachable = redisConfig.parse({
      REDIS_URL: 'redis://127.0.0.1:1',
      REDIS_CONNECT_TIMEOUT_MS: '200',
    });
    const adapter = new RedisIoAdapter(asApp(createServer()), unreachable);
    await expect(adapter.connectToRedis()).rejects.toThrow(/not ready after 200ms/);
    expect(Reflect.get(adapter, 'clients')).toEqual([]);
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });
});
