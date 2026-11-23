/**
 * The revocation channel against a REAL Redis: two replicas, each with its own main and subscriber
 * connection (as `RedisModule` builds them). Needs a running Redis at `INTEGRATION_REDIS_URL` or
 * `REDIS_URL` (for example `bun run docker:infra`); not testcontainers. Opt-in:
 *   INTEGRATION=1 bunx vitest run --project auth:int
 * Every key lives under a random prefix and is removed afterwards.
 */
import { Logger } from '@nestjs/common';
import { generateId } from '@platform/common';
import { authConfig, redisConfig } from '@platform/config';
import {
  closeRedisClient,
  createRedisClient,
  RedisKeyService,
  waitForRedisReady,
} from '@platform/redis';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { AccessTokenDenylist } from '../tokens/access-token-denylist.service.js';
import { type RevocableSession, RevocationSweeper } from './revocation-sweeper.js';

const url = process.env['INTEGRATION_REDIS_URL'] ?? process.env['REDIS_URL'];
const config = redisConfig.parse({
  ...(url === undefined ? {} : { REDIS_URL: url }),
  REDIS_KEY_PREFIX: `it-${generateId()}`,
});
const keys = new RedisKeyService(config);
const channel = keys.key('auth', 'revoked');
// The sweep interval at its maximum: what closes a session here is the channel, not the timer.
const auth = authConfig.parse({ NODE_ENV: 'test', WS_REVOCATION_SWEEP_INTERVAL_MS: '300000' });
const inAMinute = (): number => Math.floor(Date.now() / 1_000) + 60;

interface Replica {
  main: Redis;
  subscriber: Redis;
  denylist: AccessTokenDenylist;
  sweeper: RevocationSweeper;
}

async function startReplica(): Promise<Replica> {
  const main = createRedisClient(config);
  await waitForRedisReady(main, 5_000);
  const subscriber = main.duplicate({ lazyConnect: true });
  const denylist = new AccessTokenDenylist(main, keys, auth, subscriber);
  const sweeper = new RevocationSweeper(denylist, {
    name: 'int',
    intervalMs: auth.wsRevocationSweepIntervalMs,
  });
  sweeper.start();
  return { main, subscriber, denylist, sweeper };
}

function session(jti: string): RevocableSession & { end: Mock<() => void> } {
  return { jti, end: vi.fn<() => void>() };
}

describe('RevocationSweeper on the revocation channel (real Redis, two replicas)', () => {
  let a: Replica;
  let b: Replica;

  beforeAll(async () => {
    a = await startReplica();
    b = await startReplica();
    // SUBSCRIBE is asynchronous: wait until both subscriber connections are on the channel.
    await vi.waitFor(
      async () => {
        const reply = (await a.main.call('PUBSUB', 'NUMSUB', channel)) as [string, number];
        expect(Number(reply[1])).toBe(2);
      },
      { timeout: 5_000, interval: 20 },
    );
  });

  afterAll(async () => {
    a.sweeper.stop();
    b.sweeper.stop();
    const stream = a.main.scanStream({ match: `${config.keyPrefix}:*`, count: 500 });
    for await (const batch of stream as AsyncIterable<string[]>) {
      if (batch.length > 0) await a.main.unlink(...batch);
    }
    await Promise.allSettled(
      [a, b].flatMap(({ main, subscriber }) => [
        closeRedisClient(subscriber),
        closeRedisClient(main),
      ]),
    );
  });

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  it('deny() on one replica closes the session on the other at once, not by a sweep', async () => {
    const isDenied = vi.spyOn(b.denylist, 'isDenied');
    const revoked = session(generateId());
    const live = session(generateId());
    b.sweeper.track(revoked);
    const untrackLive = b.sweeper.track(live);

    await a.denylist.deny(revoked.jti, inAMinute());

    await vi.waitFor(() => expect(revoked.end).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(live.end).not.toHaveBeenCalled();
    expect(isDenied).not.toHaveBeenCalled();
    untrackLive();
  });

  it('mixed versions: a key SET without a publish (an old replica) is closed by the next sweep', async () => {
    const revoked = session(generateId());
    const untrack = b.sweeper.track(revoked);

    await a.main.set(keys.key('auth', 'denylist', revoked.jti), '1', 'EX', 60);
    // A later publish on the same connection arrives after anything the SET could have caused.
    const marker = session(generateId());
    b.sweeper.track(marker);
    await a.denylist.deny(marker.jti, inAMinute());
    await vi.waitFor(() => expect(marker.end).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(revoked.end).not.toHaveBeenCalled();

    await expect(b.sweeper.sweep()).resolves.toBeGreaterThanOrEqual(1);
    expect(revoked.end).toHaveBeenCalledTimes(1);
    untrack();
  });

  it('ignores a malformed message and keeps listening', async () => {
    const target = session(generateId());
    const untrack = b.sweeper.track(target);

    for (const garbage of [target.jti, `{"jti":["${target.jti}"]}`, '{"jti":', '']) {
      await a.main.publish(channel, garbage);
    }
    // Messages on one channel arrive in order: once this one is handled, the garbage was too.
    const marker = session(generateId());
    b.sweeper.track(marker);
    await a.denylist.deny(marker.jti, inAMinute());
    await vi.waitFor(() => expect(marker.end).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(target.end).not.toHaveBeenCalled();

    await a.denylist.deny(target.jti, inAMinute());
    await vi.waitFor(() => expect(target.end).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    untrack();
  });
});
