import { Logger } from '@nestjs/common';
import { ServiceUnavailableException } from '@platform/common';
import { authConfig, redisConfig } from '@platform/config';
import { RedisKeyService } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DENYLIST_CHECK_TIMEOUT_MS } from '../auth.constants.js';
import { AccessTokenDenylist } from './access-token-denylist.service.js';

const keys = new RedisKeyService(redisConfig.parse({ REDIS_KEY_PREFIX: 'svc' }));
const enabled = authConfig.parse({ NODE_ENV: 'test' });
const disabled = authConfig.parse({ NODE_ENV: 'test', AUTH_DENYLIST_ENABLED: 'false' });

describe('AccessTokenDenylist', () => {
  let redis: InMemoryRedis;
  const nowSec = (): number => Math.floor(Date.now() / 1_000);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    redis = new InMemoryRedis();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('denies a jti for its remaining lifetime (+ clock tolerance) under the prefixed key', async () => {
    const denylist = new AccessTokenDenylist(redis.asRedis(), keys, enabled);
    await denylist.deny('jti-1', nowSec() + 600);
    await expect(denylist.isDenied('jti-1')).resolves.toBe(true);
    await expect(denylist.isDenied('jti-2')).resolves.toBe(false);
    await expect(redis.ttl('svc:auth:denylist:jti-1')).resolves.toBe(605);

    vi.setSystemTime(Date.now() + 606_000);
    await expect(denylist.isDenied('jti-1')).resolves.toBe(false); // expired with the token
  });

  it('still denies tokens inside the clock-tolerance window, skips hopeless ones', async () => {
    const denylist = new AccessTokenDenylist(redis.asRedis(), keys, enabled);
    await denylist.deny('recent', nowSec() - 2);
    await expect(redis.ttl('svc:auth:denylist:recent')).resolves.toBe(3);
    await denylist.deny('ancient', nowSec() - 60);
    expect(redis.calls.filter((c) => c === 'set')).toHaveLength(1);
  });

  it('is a no-op when AUTH_DENYLIST_ENABLED=false', async () => {
    const denylist = new AccessTokenDenylist(redis.asRedis(), keys, disabled);
    expect(denylist.enabled).toBe(false);
    await denylist.deny('jti-1', nowSec() + 600);
    await expect(denylist.isDenied('jti-1')).resolves.toBe(false);
    expect(redis.calls).toEqual([]);
  });

  it('fails closed (503) when Redis cannot answer', async () => {
    const denylist = new AccessTokenDenylist(redis.asRedis(), keys, enabled);
    redis.simulateOutage();
    await expect(denylist.isDenied('jti-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('AccessTokenDenylist while Redis is unreachable but not yet failing', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fails closed (503) within the timeout instead of waiting in the offline queue', async () => {
    vi.useFakeTimers();
    const redis = new InMemoryRedis();
    // A command parked in ioredis' offline queue (blackholed host): it never settles in time.
    vi.spyOn(redis, 'exists').mockImplementation(() => new Promise<number>(() => undefined));
    const denylist = new AccessTokenDenylist(redis.asRedis(), keys, enabled);

    let settled = false;
    const check = denylist.isDenied('jti-1').finally(() => {
      settled = true;
    });
    const assertion = expect(check).rejects.toBeInstanceOf(ServiceUnavailableException);

    await vi.advanceTimersByTimeAsync(DENYLIST_CHECK_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });
});

describe('AccessTokenDenylist revocation channel ({prefix}:auth:revoked)', () => {
  const CHANNEL = 'svc:auth:revoked';
  const inAMinute = (): number => Math.floor(Date.now() / 1_000) + 60;
  /** `publish` delivers on `setImmediate`, like a real round trip. */
  const delivered = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** One replica: a main connection and its subscriber connection on a shared in-memory Redis. */
  function replicaOn(redis: InMemoryRedis, config = enabled) {
    const subscriber = redis.duplicate();
    const denylist = new AccessTokenDenylist(redis.asRedis(), keys, config, subscriber.asRedis());
    return { denylist, subscriber };
  }

  it('publishes {"jti"} on the channel after the SET', async () => {
    const redis = new InMemoryRedis();
    const listener = redis.duplicate();
    await listener.subscribe(CHANNEL);
    const messages: [string, string][] = [];
    listener.on('message', (channel: string, message: string) => messages.push([channel, message]));
    const denylist = new AccessTokenDenylist(redis.asRedis(), keys, enabled);

    await denylist.deny('jti-1', inAMinute());
    await delivered();

    expect(redis.calls).toEqual(['set', 'publish']);
    expect(messages).toEqual([[CHANNEL, JSON.stringify({ jti: 'jti-1' })]]);
  });

  it('publishes nothing for a hopeless token or when the denylist is disabled', async () => {
    const redis = new InMemoryRedis();
    await new AccessTokenDenylist(redis.asRedis(), keys, enabled).deny('old', inAMinute() - 600);
    await new AccessTokenDenylist(redis.asRedis(), keys, disabled).deny('jti-1', inAMinute());
    expect(redis.calls).toEqual([]);
  });

  it('logs a failed publish without the jti and never throws: the key is set', async () => {
    const redis = new InMemoryRedis();
    vi.spyOn(redis, 'publish').mockRejectedValue(new Error('READONLY replica'));
    const denylist = new AccessTokenDenylist(redis.asRedis(), keys, enabled);

    await expect(denylist.deny('jti-secret', inAMinute())).resolves.toBeUndefined();

    await expect(denylist.isDenied('jti-secret')).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('READONLY replica');
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('jti-secret');
  });

  it('hands every listener the jti another replica denied, subscribing once', async () => {
    const redis = new InMemoryRedis();
    const own = replicaOn(redis);
    const other = replicaOn(redis.duplicate());
    const first = vi.fn<(jti: string) => void>();
    const second = vi.fn<(jti: string) => void>();
    own.denylist.onRevoked(first);
    own.denylist.onRevoked(second);

    await other.denylist.deny('jti-1', inAMinute());
    await delivered();

    expect(first).toHaveBeenCalledExactlyOnceWith('jti-1');
    expect(second).toHaveBeenCalledExactlyOnceWith('jti-1');
    expect(own.subscriber.calls.filter((call) => call === 'subscribe')).toHaveLength(1);
  });

  it('ignores malformed messages and other channels without a Redis call', async () => {
    const redis = new InMemoryRedis();
    const { denylist, subscriber } = replicaOn(redis);
    const listener = vi.fn<(jti: string) => void>();
    denylist.onRevoked(listener);
    const before = [...redis.calls];

    for (const garbage of ['not json', '"jti-1"', 'null', '{}', '{"jti":42}', '{"jti":""}', '[]']) {
      await redis.publish(CHANNEL, garbage);
    }
    await redis.publish('svc:cache:invalidate', JSON.stringify({ jti: 'jti-1' }));
    await delivered();

    expect(listener).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(redis.calls.filter((call) => call !== 'publish')).toEqual(before);
    expect(subscriber.calls).toEqual(['subscribe']);
  });

  it('stops calling a listener once unregistered (idempotent) and survives a throwing one', async () => {
    const redis = new InMemoryRedis();
    const own = replicaOn(redis);
    const other = replicaOn(redis.duplicate());
    const throwing = vi.fn<(jti: string) => void>(() => {
      throw new Error('socket gone');
    });
    const kept = vi.fn<(jti: string) => void>();
    const dropped = vi.fn<(jti: string) => void>();
    own.denylist.onRevoked(throwing);
    own.denylist.onRevoked(kept);
    const unregister = own.denylist.onRevoked(dropped);
    unregister();
    unregister();

    await other.denylist.deny('jti-1', inAMinute());
    await delivered();

    expect(throwing).toHaveBeenCalledOnce();
    expect(kept).toHaveBeenCalledExactlyOnceWith('jti-1');
    expect(dropped).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not listen without a subscriber connection or when disabled (deny still publishes)', async () => {
    const redis = new InMemoryRedis();
    const sweepOnly = new AccessTokenDenylist(redis.asRedis(), keys, enabled);
    const off = replicaOn(redis, disabled);
    const listener = vi.fn<(jti: string) => void>();
    sweepOnly.onRevoked(listener)();
    off.denylist.onRevoked(listener);

    await sweepOnly.deny('jti-1', inAMinute());
    await delivered();

    expect(listener).not.toHaveBeenCalled();
    expect(off.subscriber.calls).toEqual([]);
    expect(redis.calls).toEqual(['set', 'publish']);
  });
});
