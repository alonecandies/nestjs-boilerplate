import { describe, expect, it, vi } from 'vitest';
import { InMemoryRedis } from '../testing/in-memory-redis.js';
import { subscribeToChannel } from './channel-subscription.js';

/** `publish` delivers on `setImmediate`, like a real round trip. */
const delivered = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function connections() {
  const redis = new InMemoryRedis();
  const subscriber = redis.duplicate();
  const logger = { warn: vi.fn<(message: string) => void>() };
  return { redis, subscriber, logger };
}

describe('subscribeToChannel', () => {
  it("hands over its own channel's payloads only, after one SUBSCRIBE", async () => {
    const { redis, subscriber, logger } = connections();
    const onMessage = vi.fn<(message: string) => void>();
    subscribeToChannel(subscriber.asRedis(), 'svc:a', onMessage, { logger });
    await subscriber.subscribe('svc:b'); // another listener's channel on the shared connection

    await redis.publish('svc:a', 'one');
    await redis.publish('svc:b', 'other');
    await delivered();

    expect(onMessage.mock.calls).toEqual([['one']]);
    expect(subscriber.calls).toEqual(['subscribe', 'subscribe']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('attaches the listener before the SUBSCRIBE settles, and does not wait for it', () => {
    const { subscriber, logger } = connections();
    vi.spyOn(subscriber, 'subscribe').mockReturnValue(new Promise<number>(() => undefined));

    subscribeToChannel(subscriber.asRedis(), 'svc:a', () => undefined, { logger });

    expect(subscriber.listenerCount('message')).toBe(1);
  });

  it('detaches once (idempotent) and never sends UNSUBSCRIBE on the shared connection', async () => {
    const { redis, subscriber, logger } = connections();
    const kept = vi.fn<(message: string) => void>();
    const dropped = vi.fn<(message: string) => void>();
    subscribeToChannel(subscriber.asRedis(), 'svc:a', kept, { logger });
    const remove = subscribeToChannel(subscriber.asRedis(), 'svc:a', dropped, { logger });

    remove();
    remove();
    await redis.publish('svc:a', 'one');
    await delivered();

    expect(kept).toHaveBeenCalledExactlyOnceWith('one');
    expect(dropped).not.toHaveBeenCalled();
    expect(subscriber.listenerCount('message')).toBe(1);
    expect(subscriber.calls).not.toContain('unsubscribe');
  });

  it('logs a failed SUBSCRIBE, then calls onError; the listener stays unless onError removes it', async () => {
    const { subscriber, logger } = connections();
    const failure = new Error('Connection is closed.');
    vi.spyOn(subscriber, 'subscribe').mockRejectedValue(failure);
    const onError = vi.fn<(error: unknown) => void>();

    subscribeToChannel(subscriber.asRedis(), 'svc:a', () => undefined, { logger });
    const remove = subscribeToChannel(subscriber.asRedis(), 'svc:b', () => undefined, {
      logger,
      onError: (error) => {
        onError(error);
        remove();
      },
    });
    await delivered();

    expect(logger.warn.mock.calls).toEqual([
      ['cannot subscribe to svc:a: Connection is closed.'],
      ['cannot subscribe to svc:b: Connection is closed.'],
    ]);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(subscriber.listenerCount('message')).toBe(1);
  });
});
