import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { isNumber, isString } from 'lodash-es';
import { THROTTLE_COMMAND, type ThrottleReply } from '../throttler/throttle.command.js';

type Entry = { value: string; expiresAt: number | undefined };
type ScriptImplementation = (redis: InMemoryRedis, keys: string[], args: string[]) => unknown;

interface SharedState {
  readonly store: Map<string, Entry>;
  readonly clients: Set<InMemoryRedis>;
}

export type InMemoryRedisStatus = 'wait' | 'connecting' | 'ready' | 'reconnecting' | 'end';

export interface InMemoryRedisOptions {
  /** Clock used for expirations (inject a fake to test TTL logic deterministically). */
  now?: () => number;
  connectionName?: string;
}

/**
 * JS model of `THROTTLE_SCRIPT` (throttle.command.ts), statement by statement, executed on the
 * in-memory primitives. Keep both in sync — `throttle.command.int-spec.ts` runs the real Lua
 * against Redis with the same expectations as the unit tests of this model.
 */
function throttleScriptModel(redis: InMemoryRedis, keys: string[], args: string[]): ThrottleReply {
  const [hitsKey = '', blockKey = ''] = keys;
  const [ttl = 0, limit = 0, block = 0] = args.map(Number);
  const blockTtl = redis.pttlSync(blockKey);
  if (blockTtl > 0) return [Number(redis.getSync(blockKey) ?? 0), blockTtl, 1, blockTtl];
  const hits = redis.incrSync(hitsKey);
  let hitsTtl = redis.pttlSync(hitsKey);
  if (hitsTtl < 0) {
    redis.pexpireSync(hitsKey, ttl);
    hitsTtl = ttl;
  }
  if (hits <= limit) return [hits, hitsTtl, 0, 0];
  if (block > 0) {
    redis.setSync(blockKey, String(hits), block);
    redis.delSync(hitsKey);
    return [hits, block, 1, block];
  }
  return [hits, hitsTtl, 1, hitsTtl];
}

const EMULATED_SCRIPTS = new Map<string, ScriptImplementation>([
  [THROTTLE_COMMAND, throttleScriptModel],
]);

/**
 * Minimal in-memory stand-in for an ioredis client, for unit/e2e tests that must run without
 * Redis: strings with PX/EX expiry, counters, pub/sub between `duplicate()`d clients, and the Lua
 * commands this package defines (emulated in JS). Anything else is intentionally missing — call
 * sites that need more should use a real Redis (`*.int-spec.ts`).
 *
 * `asRedis()` returns it typed as `Redis` for injection (`{ provide: REDIS_CLIENT, useValue }`).
 */
export class InMemoryRedis extends EventEmitter {
  status: InMemoryRedisStatus = 'ready';
  readonly options: { connectionName?: string };
  /** Every command name received, in order (handy for "was Redis called?" assertions). */
  readonly calls: string[] = [];
  private readonly now: () => number;
  private state: SharedState = { store: new Map(), clients: new Set() };
  private readonly channels = new Set<string>();

  constructor(options: InMemoryRedisOptions = {}) {
    super();
    this.now = options.now ?? Date.now;
    this.options =
      options.connectionName === undefined ? {} : { connectionName: options.connectionName };
    this.state.clients.add(this);
  }

  asRedis(): Redis {
    return this as unknown as Redis;
  }

  /** New client sharing the same keyspace and pub/sub bus (like a second connection). */
  duplicate(overrides: { connectionName?: string } = {}): InMemoryRedis {
    const connectionName = overrides.connectionName ?? this.options.connectionName;
    const copy = new InMemoryRedis({
      now: this.now,
      ...(connectionName === undefined ? {} : { connectionName }),
    });
    copy.state.clients.delete(copy);
    copy.state = this.state;
    this.state.clients.add(copy);
    return copy;
  }

  // ---- synchronous primitives (also used by emulated scripts) ------------------------------

  getSync(key: string): string | null {
    return this.live(key)?.value ?? null;
  }

  setSync(key: string, value: string, pxMs?: number): void {
    this.state.store.set(key, {
      value,
      expiresAt: pxMs === undefined ? undefined : this.now() + pxMs,
    });
  }

  delSync(...keys: string[]): number {
    let removed = 0;
    for (const key of keys) if (this.live(key) && this.state.store.delete(key)) removed++;
    return removed;
  }

  incrSync(key: string): number {
    const entry = this.live(key);
    const next = (entry ? Number(entry.value) : 0) + 1;
    if (!Number.isInteger(next)) throw new Error('ERR value is not an integer or out of range');
    this.state.store.set(key, { value: String(next), expiresAt: entry?.expiresAt });
    return next;
  }

  /** Redis semantics: -2 missing, -1 no expiry, else remaining ms. */
  pttlSync(key: string): number {
    const entry = this.live(key);
    if (!entry) return -2;
    return entry.expiresAt === undefined ? -1 : entry.expiresAt - this.now();
  }

  pexpireSync(key: string, ms: number): 0 | 1 {
    const entry = this.live(key);
    if (!entry) return 0;
    entry.expiresAt = this.now() + ms;
    return 1;
  }

  // ---- ioredis-compatible async API --------------------------------------------------------

  async get(key: string): Promise<string | null> {
    return this.run('get', () => this.getSync(key));
  }

  /** Supports `EX s`, `PX ms`, `NX`, `XX` (any order), like ioredis' variadic `set`. */
  async set(
    key: string,
    value: string | number,
    ...args: (string | number)[]
  ): Promise<'OK' | null> {
    return this.run('set', () => {
      let pxMs: number | undefined;
      let mode: 'NX' | 'XX' | undefined;
      for (let i = 0; i < args.length; i++) {
        const token = String(args[i]).toUpperCase();
        if (token === 'EX' || token === 'PX') {
          const amount = Number(args[++i]);
          pxMs = token === 'EX' ? amount * 1_000 : amount;
        } else if (token === 'NX' || token === 'XX') {
          mode = token === 'NX' ? 'NX' : 'XX';
        }
      }
      const exists = this.live(key) !== undefined;
      if ((mode === 'NX' && exists) || (mode === 'XX' && !exists)) return null;
      this.setSync(key, String(value), pxMs);
      return 'OK';
    });
  }

  async del(...keys: string[]): Promise<number> {
    return this.run('del', () => this.delSync(...keys));
  }

  async unlink(...keys: string[]): Promise<number> {
    return this.run('unlink', () => this.delSync(...keys));
  }

  async exists(...keys: string[]): Promise<number> {
    return this.run('exists', () => keys.filter((key) => this.live(key) !== undefined).length);
  }

  async incr(key: string): Promise<number> {
    return this.run('incr', () => this.incrSync(key));
  }

  async pttl(key: string): Promise<number> {
    return this.run('pttl', () => this.pttlSync(key));
  }

  async ttl(key: string): Promise<number> {
    return this.run('ttl', () => {
      const ms = this.pttlSync(key);
      return ms < 0 ? ms : Math.ceil(ms / 1_000);
    });
  }

  async pexpire(key: string, ms: number): Promise<number> {
    return this.run('pexpire', () => this.pexpireSync(key, ms));
  }

  async ping(): Promise<'PONG'> {
    return this.run('ping', () => 'PONG' as const);
  }

  async publish(channel: string, message: string): Promise<number> {
    return this.run('publish', () => {
      const receivers = [...this.state.clients].filter((client) => client.channels.has(channel));
      // Deliver asynchronously, like a real round-trip.
      for (const client of receivers) {
        setImmediate(() => client.emit('message', channel, message));
      }
      return receivers.length;
    });
  }

  async subscribe(...channels: string[]): Promise<number> {
    return this.run('subscribe', () => {
      for (const channel of channels) this.channels.add(channel);
      return this.channels.size;
    });
  }

  async unsubscribe(...channels: string[]): Promise<number> {
    return this.run('unsubscribe', () => {
      for (const channel of channels.length > 0 ? channels : [...this.channels]) {
        this.channels.delete(channel);
      }
      return this.channels.size;
    });
  }

  /** Registers an emulated Lua command (only the scripts this package ships are known). */
  defineCommand(name: string, definition: { numberOfKeys: number; lua: string }): void {
    const implementation = EMULATED_SCRIPTS.get(name);
    const numberOfKeys = definition.numberOfKeys;
    Reflect.set(
      this,
      name,
      async (...raw: (string | number)[]): Promise<unknown> =>
        this.run(name, () => {
          if (!implementation) throw new Error(`InMemoryRedis: script "${name}" is not emulated`);
          const args = raw.map(String);
          return implementation(this, args.slice(0, numberOfKeys), args.slice(numberOfKeys));
        }),
    );
  }

  async flushall(): Promise<'OK'> {
    return this.run('flushall', () => {
      this.state.store.clear();
      return 'OK' as const;
    });
  }

  async quit(): Promise<'OK'> {
    this.end();
    return 'OK';
  }

  disconnect(): void {
    this.end();
  }

  /** Simulates a connection loss: commands reject until `status` is set back to `'ready'`. */
  simulateOutage(status: Exclude<InMemoryRedisStatus, 'ready'> = 'reconnecting'): void {
    this.status = status;
  }

  private end(): void {
    if (this.status === 'end') return;
    this.status = 'end';
    this.channels.clear();
    this.state.clients.delete(this);
    this.emit('end');
  }

  private run<T>(command: string, fn: () => T): Promise<T> {
    this.calls.push(command);
    if (this.status !== 'ready') {
      return Promise.reject(new Error(`InMemoryRedis: connection is ${this.status} (${command})`));
    }
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private live(key: string): Entry | undefined {
    const entry = this.state.store.get(key);
    if (!entry) return undefined;
    if (isNumber(entry.expiresAt) && entry.expiresAt <= this.now()) {
      this.state.store.delete(key);
      return undefined;
    }
    return isString(entry.value) ? entry : undefined;
  }
}
