import { redisConfig, throttleConfig } from '@platform/config';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { hashTag } from '../keys/key.util.js';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { InMemoryRedis } from '../testing/in-memory-redis.js';
import { CONN_COUNT_COMMAND } from './conn-count.command.js';
import { ConnectionCaps, type SocketSlot } from './connection-caps.js';
import { RateLimitCharger } from './rate-limit-charger.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A fake clock start, a whole second so token `exp` (seconds) is exact. */
const T0 = 1_800_000_000_000;

function setup(
  env: Record<string, string> = {},
  ipv6SubnetPrefix?: number,
  redis = new InMemoryRedis(),
) {
  const keys = new RedisKeyService(redisConfig.parse({}));
  const storage = new RedisThrottlerStorage(redis.asRedis(), keys);
  const caps = new ConnectionCaps(
    redis.asRedis(),
    keys,
    throttleConfig.parse(env),
    new RateLimitCharger(
      storage,
      ipv6SubnetPrefix === undefined ? undefined : { throttlers: [], ipv6SubnetPrefix },
    ),
  );
  const slotKey = (userId: string) => keys.key('wsslot', hashTag(userId));
  return { redis, caps, keys, slotKey };
}

/** A token that expires in 15 minutes (the `JWT_ACCESS_TTL_SEC` default). */
const tokenExp = (): number => Math.floor(Date.now() / 1000) + 900;

const ADMITTED = { admitted: true, id: expect.any(String) };
const REFUSED = { admitted: false };

function idOf(slot: SocketSlot): string {
  if (!slot.admitted) throw new Error('expected an admitted slot');
  return slot.id;
}

describe('ConnectionCaps', () => {
  it('caps concurrent sockets per user and frees a slot on release', async () => {
    const { caps } = setup({ THROTTLE_WS_SOCKETS_PER_USER: '2' });
    const first = await caps.acquireSocket('u-1', tokenExp());
    expect(first).toEqual(ADMITTED);
    expect(await caps.acquireSocket('u-1', tokenExp())).toEqual(ADMITTED);
    expect(await caps.acquireSocket('u-1', tokenExp())).toEqual(REFUSED);
    expect(await caps.acquireSocket('u-2', tokenExp())).toEqual(ADMITTED);
    await caps.releaseSocket('u-1', idOf(first));
    expect(await caps.acquireSocket('u-1', tokenExp())).toEqual(ADMITTED);
  });

  it('gives every acquire its own slot id', async () => {
    const { caps } = setup();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add(idOf(await caps.acquireSocket('u-1', tokenExp())));
    expect(ids.size).toBe(5);
  });

  it('a release of an unknown or already released slot frees nothing', async () => {
    const { caps } = setup({ THROTTLE_WS_SOCKETS_PER_USER: '1' });
    await caps.releaseSocket('u-1', 'never-acquired');
    const slot = await caps.acquireSocket('u-1', tokenExp());
    await caps.releaseSocket('u-1', 'never-acquired');
    expect(await caps.acquireSocket('u-1', tokenExp())).toEqual(REFUSED);
    await caps.releaseSocket('u-1', idOf(slot));
    await caps.releaseSocket('u-1', idOf(slot));
    expect(await caps.acquireSocket('u-1', tokenExp())).toEqual(ADMITTED);
    expect(await caps.acquireSocket('u-1', tokenExp())).toEqual(REFUSED);
  });

  it('keeps a slot until max(now + THROTTLE_WS_SOCKET_TTL_MS, token expiry + 60 s)', async () => {
    let now = T0;
    const { caps, redis, slotKey } = setup(
      { THROTTLE_WS_SOCKETS_PER_USER: '5', THROTTLE_WS_SOCKET_TTL_MS: String(HOUR) },
      undefined,
      new InMemoryRedis({ now: () => now }),
    );
    const short = idOf(await caps.acquireSocket('u-1', (T0 + 15 * MINUTE) / 1000));
    const long = idOf(await caps.acquireSocket('u-1', (T0 + 2 * HOUR) / 1000));
    expect(redis.zscoreSync(slotKey('u-1'), short)).toBe(T0 + HOUR);
    expect(redis.zscoreSync(slotKey('u-1'), long)).toBe(T0 + 2 * HOUR + MINUTE);
    // The key lives exactly as long as its latest slot.
    expect(redis.pttlSync(slotKey('u-1'))).toBe(2 * HOUR + MINUTE);
    now = T0 + 2 * HOUR + MINUTE;
    expect(redis.zcardSync(slotKey('u-1'))).toBe(0);
  });

  it('limits handshakes per IP with a retry-after', async () => {
    const { caps } = setup({ THROTTLE_WS_HANDSHAKE_LIMIT: '2' });
    expect(await caps.admitHandshake('1.2.3.4')).toEqual({ ok: true });
    expect(await caps.admitHandshake('1.2.3.4')).toEqual({ ok: true });
    const refused = await caps.admitHandshake('1.2.3.4');
    expect(refused.ok).toBe(false);
    expect(await caps.admitHandshake('5.6.7.8')).toEqual({ ok: true });
  });

  it('collapses IPv6 handshakes to the configured subnet prefix, not a fixed /64 (F7)', async () => {
    const { caps } = setup({ THROTTLE_WS_HANDSHAKE_LIMIT: '1' }, 48);
    // Same /48, different /64s: one bucket.
    expect(await caps.admitHandshake('2001:db8:1:1::1')).toEqual({ ok: true });
    expect((await caps.admitHandshake('2001:db8:1:2::1')).ok).toBe(false);
    expect(await caps.admitHandshake('2001:db8:2::1')).toEqual({ ok: true });
  });

  it('defaults to the /64 the guards use', async () => {
    const { caps } = setup({ THROTTLE_WS_HANDSHAKE_LIMIT: '1' });
    expect(await caps.admitHandshake('2001:db8:1:1::1')).toEqual({ ok: true });
    expect((await caps.admitHandshake('2001:db8:1:1::2')).ok).toBe(false);
    expect(await caps.admitHandshake('2001:db8:1:2::1')).toEqual({ ok: true });
  });

  it('fails open when Redis is down', async () => {
    const { redis, caps } = setup({
      THROTTLE_WS_SOCKETS_PER_USER: '1',
      THROTTLE_WS_HANDSHAKE_LIMIT: '1',
    });
    redis.simulateOutage();
    const slot = await caps.acquireSocket('u-1', tokenExp());
    expect(slot).toEqual(ADMITTED);
    expect(await caps.acquireSocket('u-1', tokenExp())).toEqual(ADMITTED);
    expect((await caps.admitHandshake('1.2.3.4')).ok).toBe(true);
    await expect(caps.releaseSocket('u-1', idOf(slot))).resolves.toBeUndefined();
  });

  it('a slot admitted while Redis is down is not counted, and its release frees no other slot (F2)', async () => {
    const { redis, caps, slotKey } = setup({ THROTTLE_WS_SOCKETS_PER_USER: '2' });
    expect(await caps.acquireSocket('u-1', tokenExp())).toEqual(ADMITTED);
    redis.simulateOutage();
    const slot = await caps.acquireSocket('u-1', tokenExp());
    expect(slot).toEqual(ADMITTED);
    redis.status = 'ready';
    await caps.releaseSocket('u-1', idOf(slot));
    expect(redis.zcardSync(slotKey('u-1'))).toBe(1);
    expect(await caps.acquireSocket('u-1', tokenExp())).toEqual(ADMITTED);
    expect(await caps.acquireSocket('u-1', tokenExp())).toEqual(REFUSED);
  });

  it('a slot whose Lua call throws is admitted with an id to release', async () => {
    const { redis, caps } = setup({ THROTTLE_WS_SOCKETS_PER_USER: '1' });
    Reflect.set(redis, CONN_COUNT_COMMAND, async () => {
      throw new Error('timeout');
    });
    expect(await caps.acquireSocket('u-1', tokenExp())).toEqual(ADMITTED);
  });
});

/**
 * What can happen to one slot command on a real connection:
 * - `reject-before`: the connection drops before the command is sent (it never runs);
 * - `lost-reply`: it runs, then the connection drops before the reply (the caller sees an error);
 * - `twice`: it runs, the reply is lost, and ioredis resends it after reconnecting
 *   (`autoResendUnfulfilledCommands`), so it runs again.
 * A not-ready connection is `SlotWorld.notReady`.
 */
type Fault = 'reject-before' | 'lost-reply' | 'twice';

/** Injects one fault into the next Redis command `ConnectionCaps` sends (not `defineCommand`). */
function withFaults(redis: InMemoryRedis): { client: Redis; next: (fault: Fault) => void } {
  const queued: Fault[] = [];
  const client = new Proxy(redis, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      // The emulated script must run on the client itself, not through this proxy.
      if (property === 'defineCommand') return value.bind(target);
      return async (...args: unknown[]): Promise<unknown> => {
        const command = (): unknown => Reflect.apply(value, target, args);
        switch (queued.shift()) {
          case 'reject-before':
            throw new Error('connection lost before the command was sent');
          case 'lost-reply':
            await command();
            throw new Error('connection lost before the reply');
          case 'twice':
            await command();
            return command();
          default:
            return command();
        }
      };
    },
  });
  return { client: client as unknown as Redis, next: (fault) => queued.push(fault) };
}

/** One user's sockets against faulty Redis, with the invariants checked after every step. */
class SlotWorld {
  t = T0;
  readonly redis = new InMemoryRedis({ now: () => this.t });
  readonly caps: ConnectionCaps;
  /** Open sockets: name → slot id, and whether Redis counted the slot when it was admitted. */
  readonly live = new Map<string, { id: string; counted: boolean }>();
  private readonly faults: ReturnType<typeof withFaults>;
  private readonly key: string;

  constructor(readonly cap = 2) {
    const keys = new RedisKeyService(redisConfig.parse({}));
    this.key = keys.key('wsslot', hashTag('u-1'));
    this.faults = withFaults(this.redis);
    this.caps = new ConnectionCaps(
      this.faults.client,
      keys,
      throttleConfig.parse({
        THROTTLE_WS_SOCKETS_PER_USER: String(cap),
        THROTTLE_WS_SOCKET_TTL_MS: String(HOUR),
      }),
      new RateLimitCharger(new RedisThrottlerStorage(this.redis.asRedis(), keys)),
    );
  }

  /** Opens socket `name` with a token valid for `tokenMs`; resolves whether it was admitted. */
  async open(name: string, opts: { fault?: Fault; tokenMs?: number } = {}): Promise<boolean> {
    if (opts.fault) this.faults.next(opts.fault);
    const slot = await this.caps.acquireSocket(
      'u-1',
      (this.t + (opts.tokenMs ?? 15 * MINUTE)) / 1000,
    );
    if (slot.admitted) {
      this.live.set(name, {
        id: slot.id,
        counted: this.redis.zscoreSync(this.key, slot.id) !== null,
      });
    }
    this.check();
    return slot.admitted;
  }

  /** Closes socket `name`: its transport releases the slot it was admitted with. */
  async close(name: string, opts: { fault?: Fault } = {}): Promise<void> {
    const socket = this.live.get(name);
    if (!socket) throw new Error(`${name} is not open`);
    this.live.delete(name);
    if (opts.fault) this.faults.next(opts.fault);
    await this.caps.releaseSocket('u-1', socket.id);
    this.check();
  }

  /** Runs `step` while the connection is not ready (offline queue dropped), then reconnects. */
  async notReady(step: () => Promise<unknown>): Promise<void> {
    this.redis.simulateOutage();
    await step();
    this.redis.status = 'ready';
  }

  advance(ms: number): void {
    this.t += ms;
    this.check();
  }

  /** Slots whose deadline has not passed: the ones an acquire would count. */
  held(): number {
    return this.redis.zrangeWithScoresSync(this.key, 0, -1).filter(([, score]) => score > this.t)
      .length;
  }

  private check(): void {
    const counted = [...this.live.values()].filter((socket) => socket.counted);
    // No counted socket ever loses its slot, so the cap holds as soon as Redis answers...
    expect(this.held()).toBeGreaterThanOrEqual(counted.length);
    for (const { id } of counted) expect(this.redis.zscoreSync(this.key, id)).not.toBeNull();
    // ...and never more counted sockets than the cap.
    expect(counted.length).toBeLessThanOrEqual(this.cap);
    // The key never expires before its latest slot.
    const [last] = this.redis.zrangeWithScoresSync(this.key, -1, -1);
    if (last) expect(this.t + this.redis.pttlSync(this.key)).toBeGreaterThanOrEqual(last[1]);
  }
}

describe('socket slots under Redis faults (RL-3)', () => {
  it('a resent release never over-admits', async () => {
    const world = new SlotWorld();
    expect(await world.open('A')).toBe(true);
    expect(await world.open('B')).toBe(true);
    // A's release runs twice: the second removes nothing, B keeps its slot.
    await world.close('A', { fault: 'twice' });
    const admitted = [await world.open('C'), await world.open('D')];
    expect(admitted.filter(Boolean)).toHaveLength(1);
    expect(world.live.size).toBe(2);
  });

  it('a resent acquire at the cap is still admitted, and counted once', async () => {
    const world = new SlotWorld();
    expect(await world.open('A')).toBe(true);
    // B's acquire runs twice: the resend finds B's slot and admits it again.
    expect(await world.open('B', { fault: 'twice' })).toBe(true);
    expect(world.redis.calls.filter((name) => name === CONN_COUNT_COMMAND)).toHaveLength(3);
    expect(world.held()).toBe(2);
    expect(await world.open('C')).toBe(false);
  });

  it('a lost reply or a not-ready release leaks a slot only until its deadline', async () => {
    const world = new SlotWorld();
    // E's acquire runs but its reply is lost: admitted (fail open), released at close all the same.
    expect(await world.open('E', { fault: 'lost-reply' })).toBe(true);
    expect(world.held()).toBe(1);
    await world.close('E');
    expect(world.held()).toBe(0);
    // F's release meets a not-ready connection: its slot leaks.
    expect(await world.open('F')).toBe(true);
    await world.notReady(() => world.close('F'));
    expect(world.held()).toBe(1);
    // The user keeps reconnecting every 30 minutes for 3 hours (15-minute tokens).
    for (let i = 0; i < 6; i++) {
      expect(await world.open(`G${i}`)).toBe(true);
      world.advance(15 * MINUTE);
      await world.close(`G${i}`);
      world.advance(15 * MINUTE);
    }
    // F's deadline (1 h) has long passed: the user can hold two sockets again.
    expect(world.held()).toBe(0);
    expect(await world.open('X')).toBe(true);
    expect(await world.open('Y')).toBe(true);
    expect(await world.open('Z')).toBe(false);
  });

  it('an acquire that never ran is admitted uncounted, and its release changes nothing', async () => {
    const world = new SlotWorld();
    expect(await world.open('I')).toBe(true);
    expect(await world.open('H', { fault: 'reject-before' })).toBe(true);
    expect(world.live.get('H')?.counted).toBe(false);
    expect(world.held()).toBe(1);
    await world.close('H');
    expect(world.held()).toBe(1);
    // The cap still holds for the counted socket: one more, not two.
    expect(await world.open('J')).toBe(true);
    expect(await world.open('K')).toBe(false);
  });

  it("the key's expiry never shortens: a later, shorter slot does not drop an earlier one", async () => {
    const world = new SlotWorld();
    expect(await world.open('A', { tokenMs: 2 * HOUR })).toBe(true);
    world.advance(MINUTE);
    expect(await world.open('B', { tokenMs: 15 * MINUTE })).toBe(true);
    world.advance(15 * MINUTE);
    await world.close('B');
    // Past B's deadline (1 h after it opened), not A's (its token + 60 s).
    world.advance(HOUR - 15 * MINUTE + 1);
    expect(world.held()).toBe(1);
    expect(await world.open('C')).toBe(true);
    expect(await world.open('D')).toBe(false);
  });
});
