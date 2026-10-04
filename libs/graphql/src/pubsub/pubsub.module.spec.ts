import { AppConfigModule } from '@app/config';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RedisPubSub } from 'graphql-redis-subscriptions';
import { PubSub } from 'graphql-subscriptions';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GRAPHQL_PUB_SUB, type GraphqlPubSub } from './pubsub.constants.js';
import { GraphqlPubSubModule, GraphqlPubSubShutdown } from './pubsub.module.js';

/** Just enough of an ioredis client for RedisPubSub's constructor and our shutdown hook. */
function fakeRedis(quit: () => Promise<'OK'> = async () => 'OK') {
  return {
    status: 'ready',
    on: vi.fn(),
    quit: vi.fn(quit),
    disconnect: vi.fn(),
  };
}

describe('GraphqlPubSubModule', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('provides an in-memory PubSub for tests and delivers published events', async () => {
    @Module({
      imports: [AppConfigModule.forRoot(), GraphqlPubSubModule.forRootAsync({ inMemory: true })],
    })
    class TestModule {}
    const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
    try {
      const pubSub = app.get<GraphqlPubSub>(GRAPHQL_PUB_SUB);
      expect(pubSub).toBeInstanceOf(PubSub);

      const iterator = pubSub.asyncIterableIterator<{ notificationCreated: { id: string } }>(
        'notificationCreated',
      );
      const next = iterator.next();
      await pubSub.publish('notificationCreated', { notificationCreated: { id: 'n1' } });

      await expect(next).resolves.toEqual({
        done: false,
        value: { notificationCreated: { id: 'n1' } },
      });
      await iterator.return?.();
    } finally {
      await app.close();
    }
  });
});

describe('GraphqlPubSubShutdown', () => {
  it('QUITs both RedisPubSub connections', async () => {
    const publisher = fakeRedis();
    const subscriber = fakeRedis();
    const pubSub = new RedisPubSub({
      publisher: publisher as unknown as Redis,
      subscriber: subscriber as unknown as Redis,
    });

    await new GraphqlPubSubShutdown(pubSub).onApplicationShutdown();

    expect(publisher.quit).toHaveBeenCalledOnce();
    expect(subscriber.quit).toHaveBeenCalledOnce();
    expect(publisher.disconnect).not.toHaveBeenCalled();
  });

  it('falls back to a hard disconnect when QUIT hangs (shutdown never blocks)', async () => {
    vi.useFakeTimers();
    const hanging = fakeRedis(() => new Promise<'OK'>(() => undefined));
    const healthy = fakeRedis();
    const pubSub = new RedisPubSub({
      publisher: healthy as unknown as Redis,
      subscriber: hanging as unknown as Redis,
    });

    const done = new GraphqlPubSubShutdown(pubSub).onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(2_000);
    await done;

    expect(hanging.disconnect).toHaveBeenCalledOnce();
    expect(healthy.disconnect).not.toHaveBeenCalled();
  });

  it('is a no-op for the in-memory engine', async () => {
    await expect(
      new GraphqlPubSubShutdown(new PubSub()).onApplicationShutdown(),
    ).resolves.toBeUndefined();
  });
});
