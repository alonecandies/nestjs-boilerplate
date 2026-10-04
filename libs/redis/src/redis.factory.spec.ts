import { redisConfig } from '@app/config';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeRedisClient,
  createRedisClient,
  REDIS_MAX_RECONNECT_DELAY_MS,
  reconnectOnReadonly,
  redactRedisUrl,
  redisRetryStrategy,
  waitForRedisReady,
} from './redis.factory.js';
import { InMemoryRedis } from './testing/in-memory-redis.js';

const config = redisConfig.parse({
  REDIS_URL: 'redis://user:s3cret@localhost:6390/2',
  REDIS_KEY_PREFIX: 'test',
  REDIS_MAX_RETRIES_PER_REQUEST: '2',
  REDIS_CONNECT_TIMEOUT_MS: '1234',
});

describe('redis.factory helpers', () => {
  it('redacts passwords from URLs', () => {
    expect(redactRedisUrl('redis://user:s3cret@host:6379/0')).toBe('redis://user:***@host:6379/0');
    expect(redactRedisUrl('redis://host:6379')).toBe('redis://host:6379');
    expect(redactRedisUrl('not a url')).toBe('<invalid redis url>');
  });

  it('reconnects and resends on READONLY (failover), ignores other errors', () => {
    expect(
      reconnectOnReadonly(new Error('READONLY You cannot write against a read only replica')),
    ).toBe(2);
    expect(reconnectOnReadonly(new Error('ECONNRESET'))).toBe(false);
  });

  it('backs off exponentially with jitter, capped', () => {
    for (let attempt = 1; attempt <= 30; attempt++) {
      const delay = redisRetryStrategy(attempt);
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(REDIS_MAX_RECONNECT_DELAY_MS);
    }
  });
});

describe('createRedisClient', () => {
  const clients: Redis[] = [];
  afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect();
  });

  it('applies throughput defaults from config (without connecting when lazy)', () => {
    const client = createRedisClient(config, { lazyConnect: true });
    clients.push(client);
    expect(client.status).toBe('wait');
    expect(client.options).toMatchObject({
      host: 'localhost',
      port: 6390,
      db: 2,
      username: 'user',
      password: 's3cret',
      enableAutoPipelining: true,
      maxRetriesPerRequest: 2,
      connectTimeout: 1234,
      connectionName: 'test',
      keepAlive: 30_000,
      noDelay: true,
    });
    expect(client.options.keyPrefix).toBe('');
    expect(client.listenerCount('error')).toBe(1);
  });

  it('refuses ioredis keyPrefix (breaks BullMQ / redlock)', () => {
    const overrides = { keyPrefix: 'x:' } as unknown as Parameters<typeof createRedisClient>[1];
    expect(() => createRedisClient(config, overrides)).toThrow(/keyPrefix/);
  });
});

describe('waitForRedisReady', () => {
  it('resolves immediately when ready and on the ready event otherwise', async () => {
    const ready = new InMemoryRedis();
    await expect(waitForRedisReady(ready.asRedis(), 10)).resolves.toBeUndefined();

    const connecting = new InMemoryRedis();
    connecting.on('error', () => undefined); // createRedisClient always attaches one
    connecting.status = 'connecting';
    const pending = waitForRedisReady(connecting.asRedis(), 1_000);
    connecting.emit('error', new Error('ECONNREFUSED')); // tolerated while starting
    connecting.status = 'ready';
    connecting.emit('ready');
    await expect(pending).resolves.toBeUndefined();
    expect(connecting.listenerCount('ready')).toBe(0);
  });

  it('rejects on timeout, on end, and for closed clients', async () => {
    vi.useFakeTimers();
    try {
      const slow = new InMemoryRedis();
      slow.status = 'connecting';
      const timedOut = waitForRedisReady(slow.asRedis(), 500, 'cache');
      vi.advanceTimersByTime(500);
      await expect(timedOut).rejects.toThrow(/cache: not ready after 500ms/);
    } finally {
      vi.useRealTimers();
    }

    const ending = new InMemoryRedis();
    ending.status = 'connecting';
    const ended = waitForRedisReady(ending.asRedis(), 1_000);
    ending.emit('end');
    await expect(ended).rejects.toThrow(/ended before it became ready/);

    const closed = new InMemoryRedis();
    closed.disconnect();
    await expect(waitForRedisReady(closed.asRedis(), 10)).rejects.toThrow(/already closed/);
  });
});

describe('closeRedisClient', () => {
  it('QUITs connected clients and disconnects never-connected ones', async () => {
    const connected = new InMemoryRedis();
    const quit = vi.spyOn(connected, 'quit');
    await closeRedisClient(connected.asRedis());
    expect(quit).toHaveBeenCalledOnce();
    expect(connected.status).toBe('end');

    const lazy = new InMemoryRedis();
    lazy.status = 'wait';
    const disconnect = vi.spyOn(lazy, 'disconnect');
    await closeRedisClient(lazy.asRedis());
    expect(disconnect).toHaveBeenCalledOnce();

    await expect(closeRedisClient(connected.asRedis())).resolves.toBeUndefined(); // already ended
  });

  it('falls back to disconnect() when QUIT hangs or fails', async () => {
    const hanging = new InMemoryRedis();
    vi.spyOn(hanging, 'quit').mockReturnValue(new Promise(() => undefined));
    const disconnect = vi.spyOn(hanging, 'disconnect');
    await closeRedisClient(hanging.asRedis(), 20);
    expect(disconnect).toHaveBeenCalledOnce();

    const failing = new InMemoryRedis();
    vi.spyOn(failing, 'quit').mockRejectedValue(new Error('Connection is closed.'));
    const failingDisconnect = vi.spyOn(failing, 'disconnect');
    await closeRedisClient(failing.asRedis());
    expect(failingDisconnect).toHaveBeenCalledOnce();
  });
});
