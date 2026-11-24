import { describe, expect, it, vi } from 'vitest';
import { InMemoryRedis } from './in-memory-redis.js';

describe('InMemoryRedis.pipeline', () => {
  it('runs the queued commands in order on exec() and records them as one pipeline', async () => {
    const redis = new InMemoryRedis();
    const listener = redis.duplicate();
    await listener.subscribe('ch');

    const pipeline = redis.pipeline().set('k', 'v', 'EX', 10).incr('n').get('k').publish('ch', 'm');
    expect(pipeline.length).toBe(4);
    expect(redis.calls).toEqual([]); // nothing runs before exec()

    await expect(pipeline.exec()).resolves.toEqual([
      [null, 'OK'],
      [null, 1],
      [null, 'v'],
      [null, 1],
    ]);
    expect(redis.calls).toEqual(['set', 'incr', 'get', 'publish']);
    expect(redis.pipelines).toEqual([
      [
        ['set', 'k', 'v', 'EX', 10],
        ['incr', 'n'],
        ['get', 'k'],
        ['publish', 'ch', 'm'],
      ],
    ]);
    await expect(redis.ttl('k')).resolves.toBe(10);
  });

  it('settles a failed command into its own slot, as ioredis does: exec() still resolves', async () => {
    const redis = new InMemoryRedis();
    const failure = new Error('READONLY replica');
    vi.spyOn(redis, 'publish').mockRejectedValue(failure);

    const replies = await redis.pipeline().set('k', 'v').publish('ch', 'm').get('k').exec();

    expect(replies).toEqual([
      [null, 'OK'],
      [failure, undefined],
      [null, 'v'],
    ]);
  });

  it('settles every command into an error while the connection is down', async () => {
    const redis = new InMemoryRedis();
    redis.simulateOutage();

    const replies = await redis.pipeline().set('k', 'v').publish('ch', 'm').exec();

    expect(replies.map(([error]) => error?.message)).toEqual([
      'InMemoryRedis: connection is reconnecting (set)',
      'InMemoryRedis: connection is reconnecting (publish)',
    ]);
  });
});
