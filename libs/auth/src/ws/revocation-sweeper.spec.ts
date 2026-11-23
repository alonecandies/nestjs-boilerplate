import { Logger } from '@nestjs/common';
import { authConfig, redisConfig } from '@platform/config';
import { RedisKeyService } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { AccessTokenDenylist } from '../tokens/access-token-denylist.service.js';
import { type RevocableSession, RevocationSweeper } from './revocation-sweeper.js';

const INTERVAL_MS = 1_000;

/** A fake denylist: `denied` holds the revoked jtis; `isDenied` can be swapped per test. */
function fakeDenylist(denied: Iterable<string> = []) {
  const revoked = new Set(denied);
  return {
    enabled: true,
    revoked,
    isDenied: vi.fn(async (jti: string) => revoked.has(jti)),
  };
}

function session(jti: string): RevocableSession & { end: Mock<() => void> } {
  return { jti, end: vi.fn<() => void>() };
}

function sweeperWith(denylist: ReturnType<typeof fakeDenylist>): RevocationSweeper {
  return new RevocationSweeper(denylist, { name: 'test', intervalMs: INTERVAL_MS });
}

describe('RevocationSweeper', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends and untracks the denied sessions once, leaving the others untouched', async () => {
    const denylist = fakeDenylist(['revoked']);
    const sweeper = sweeperWith(denylist);
    const revoked = session('revoked');
    const live = session('live');
    sweeper.track(revoked);
    sweeper.track(live);

    await expect(sweeper.sweep()).resolves.toBe(1);
    expect(revoked.end).toHaveBeenCalledTimes(1);
    expect(live.end).not.toHaveBeenCalled();
    expect(sweeper.size).toBe(1);

    await expect(sweeper.sweep()).resolves.toBe(0);
    expect(revoked.end).toHaveBeenCalledTimes(1);
    expect(denylist.isDenied).toHaveBeenLastCalledWith('live');
  });

  it('checks a jti shared by two sessions once and ends both', async () => {
    const denylist = fakeDenylist(['shared']);
    const sweeper = sweeperWith(denylist);
    const first = session('shared');
    const second = session('shared');
    sweeper.track(first);
    sweeper.track(second);

    await expect(sweeper.sweep()).resolves.toBe(2);
    expect(denylist.isDenied).toHaveBeenCalledTimes(1);
    expect(first.end).toHaveBeenCalledTimes(1);
    expect(second.end).toHaveBeenCalledTimes(1);
    expect(sweeper.size).toBe(0);
  });

  it('keeps every session when the denylist fails, warns once, and the next sweep works', async () => {
    const denylist = fakeDenylist(['a', 'b']);
    const sweeper = sweeperWith(denylist);
    const a = session('a');
    const b = session('b');
    sweeper.track(a);
    sweeper.track(b);
    denylist.isDenied.mockRejectedValue(new Error('redis down'));

    await expect(sweeper.sweep()).resolves.toBe(0);
    expect(a.end).not.toHaveBeenCalled();
    expect(b.end).not.toHaveBeenCalled();
    expect(sweeper.size).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);

    denylist.isDenied.mockImplementation(async (jti: string) => denylist.revoked.has(jti));
    await expect(sweeper.sweep()).resolves.toBe(2);
    expect(sweeper.size).toBe(0);
  });

  it('never overlaps: a sweep while one is in flight resolves 0 without a denylist call', async () => {
    const denylist = fakeDenylist();
    let release: (denied: boolean) => void = () => undefined;
    denylist.isDenied.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const sweeper = sweeperWith(denylist);
    const revoked = session('revoked');
    sweeper.track(revoked);

    const first = sweeper.sweep();
    await expect(sweeper.sweep()).resolves.toBe(0);
    expect(denylist.isDenied).toHaveBeenCalledTimes(1);

    release(true);
    await expect(first).resolves.toBe(1);
    expect(revoked.end).toHaveBeenCalledTimes(1);
  });

  it('makes no denylist call when the denylist is disabled', async () => {
    const denylist = { ...fakeDenylist(['revoked']), enabled: false };
    const sweeper = sweeperWith(denylist);
    const revoked = session('revoked');
    sweeper.track(revoked);

    await expect(sweeper.sweep()).resolves.toBe(0);
    expect(denylist.isDenied).not.toHaveBeenCalled();
    expect(revoked.end).not.toHaveBeenCalled();
    expect(sweeper.size).toBe(1);
  });

  it('keeps ending the other sessions when one end() throws', async () => {
    const sweeper = sweeperWith(fakeDenylist(['revoked']));
    const throwing = session('revoked');
    throwing.end.mockImplementation(() => {
      throw new Error('socket gone');
    });
    const other = session('revoked');
    sweeper.track(throwing);
    sweeper.track(other);

    await expect(sweeper.sweep()).resolves.toBe(2);
    expect(other.end).toHaveBeenCalledTimes(1);
    expect(sweeper.size).toBe(0);
  });

  it('does not end a session untracked while the denylist answers (closed mid-sweep)', async () => {
    const denylist = fakeDenylist(['revoked']);
    let release: (denied: boolean) => void = () => undefined;
    denylist.isDenied.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const sweeper = sweeperWith(denylist);
    const closing = session('revoked');
    const untrack = sweeper.track(closing);

    const sweep = sweeper.sweep();
    untrack();
    release(true);

    await expect(sweep).resolves.toBe(0);
    expect(closing.end).not.toHaveBeenCalled();
  });

  it('untracks idempotently and only the session it was returned for', () => {
    const sweeper = sweeperWith(fakeDenylist());
    const untrackFirst = sweeper.track(session('shared'));
    sweeper.track(session('shared'));
    expect(sweeper.size).toBe(2);

    untrackFirst();
    untrackFirst();
    expect(sweeper.size).toBe(1);
  });

  it('start() twice creates one unref’d timer that sweeps every interval; stop() ends sweeping', async () => {
    vi.useFakeTimers();
    const denylist = fakeDenylist();
    const sweeper = sweeperWith(denylist);
    sweeper.track(session('live'));

    sweeper.start();
    sweeper.start();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(denylist.isDenied).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(denylist.isDenied).toHaveBeenCalledTimes(2);

    sweeper.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);
    expect(denylist.isDenied).toHaveBeenCalledTimes(2);
    expect(sweeper.size).toBe(1);
  });

  it('unrefs its interval so it never holds the process open', () => {
    const unref = vi.fn();
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const sweeper = sweeperWith(fakeDenylist());

    sweeper.start();
    sweeper.stop();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), INTERVAL_MS);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('size follows track, untrack and sweep', async () => {
    const sweeper = sweeperWith(fakeDenylist(['revoked']));
    expect(sweeper.size).toBe(0);
    const untrack = sweeper.track(session('live'));
    sweeper.track(session('revoked'));
    expect(sweeper.size).toBe(2);

    await sweeper.sweep();
    expect(sweeper.size).toBe(1);
    untrack();
    expect(sweeper.size).toBe(0);
  });
});

describe('RevocationSweeper on the revocation channel (two replicas, one Redis)', () => {
  const keys = new RedisKeyService(redisConfig.parse({ REDIS_KEY_PREFIX: 'svc' }));
  // The sweep interval at its maximum: a session closed here was not closed by a sweep.
  const auth = authConfig.parse({ NODE_ENV: 'test', WS_REVOCATION_SWEEP_INTERVAL_MS: '300000' });
  const inAMinute = (): number => Math.floor(Date.now() / 1_000) + 60;
  /** `publish` delivers on `setImmediate` (not faked here), like a real round trip. */
  const delivered = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  /** A replica: its own main and subscriber connections, denylist and sweeper. */
  function replicaOn(redis: InMemoryRedis) {
    const denylist = new AccessTokenDenylist(
      redis.asRedis(),
      keys,
      auth,
      redis.duplicate().asRedis(),
    );
    const isDenied = vi.spyOn(denylist, 'isDenied');
    const sweeper = new RevocationSweeper(denylist, {
      name: 'test',
      intervalMs: auth.wsRevocationSweepIntervalMs,
    });
    sweeper.start();
    return { redis, denylist, isDenied, sweeper };
  }

  let redis: InMemoryRedis;
  let a: ReturnType<typeof replicaOn>;
  let b: ReturnType<typeof replicaOn>;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    redis = new InMemoryRedis();
    a = replicaOn(redis);
    b = replicaOn(redis.duplicate());
  });

  afterEach(() => {
    a.sweeper.stop();
    b.sweeper.stop();
    vi.useRealTimers();
  });

  it('deny() on one replica closes the session on the other before any sweep', async () => {
    expect(auth.wsRevocationSweepIntervalMs).toBe(300_000);
    const revoked = session('jti-1');
    const live = session('jti-2');
    b.sweeper.track(revoked);
    b.sweeper.track(live);

    await a.denylist.deny('jti-1', inAMinute());
    await delivered();

    expect(revoked.end).toHaveBeenCalledTimes(1);
    expect(live.end).not.toHaveBeenCalled();
    expect(b.sweeper.size).toBe(1);
    expect(b.isDenied).not.toHaveBeenCalled(); // no sweep ran

    // The next sweep does not end it a second time.
    await vi.advanceTimersByTimeAsync(auth.wsRevocationSweepIntervalMs);
    expect(b.isDenied).toHaveBeenCalledWith('jti-2');
    expect(revoked.end).toHaveBeenCalledTimes(1);
  });

  it('ends every session of the jti on every sweeper of the replica', async () => {
    const graphqlWs = new RevocationSweeper(b.denylist, {
      name: 'graphql-ws',
      intervalMs: 300_000,
    });
    graphqlWs.start();
    const onSocketIo = [session('jti-1'), session('jti-1')];
    const onGraphqlWs = session('jti-1');
    for (const s of onSocketIo) b.sweeper.track(s);
    graphqlWs.track(onGraphqlWs);

    await a.denylist.deny('jti-1', inAMinute());
    await delivered();
    graphqlWs.stop();

    for (const s of [...onSocketIo, onGraphqlWs]) expect(s.end).toHaveBeenCalledTimes(1);
    expect(b.sweeper.size + graphqlWs.size).toBe(0);
  });

  it('mixed versions: a key SET without a publish (an old replica) is closed by the next sweep', async () => {
    const revoked = session('jti-old');
    b.sweeper.track(revoked);

    await redis.set('svc:auth:denylist:jti-old', '1', 'EX', 600);
    await delivered();
    expect(revoked.end).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(auth.wsRevocationSweepIntervalMs);
    expect(revoked.end).toHaveBeenCalledTimes(1);
    expect(b.sweeper.size).toBe(0);
  });

  it('ignores a malformed message on the channel and keeps listening', async () => {
    const target = session('jti-1');
    b.sweeper.track(target);

    for (const garbage of ['jti-1', '{"jti":["jti-1"]}', '{"sub":"jti-1"}', '']) {
      await redis.publish('svc:auth:revoked', garbage);
    }
    await delivered();
    expect(target.end).not.toHaveBeenCalled();
    expect(b.sweeper.size).toBe(1);

    await a.denylist.deny('jti-1', inAMinute());
    await delivered();
    expect(target.end).toHaveBeenCalledTimes(1);
  });

  it('stop() stops listening too; after start() the sweep closes what it missed', async () => {
    const revoked = session('jti-1');
    b.sweeper.track(revoked);
    b.sweeper.stop();

    await a.denylist.deny('jti-1', inAMinute());
    await delivered();
    expect(revoked.end).not.toHaveBeenCalled();

    b.sweeper.start();
    await vi.advanceTimersByTimeAsync(auth.wsRevocationSweepIntervalMs);
    expect(revoked.end).toHaveBeenCalledTimes(1);
  });
});
