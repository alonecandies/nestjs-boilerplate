import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ThrottleConfig, throttleConfig } from '@platform/config';
import type { Redis } from 'ioredis';
import { hashTag } from '../keys/key.util.js';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { REDIS_CLIENT } from '../redis.constants.js';
import { CONN_COUNT_COMMAND, CONN_COUNT_SCRIPT } from './conn-count.command.js';
import { RateLimitCharger } from './rate-limit-charger.js';
import { GLOBAL_SCOPE, THROTTLER } from './throttle.constants.js';

/** Problem code (HTTP-style 429) for a socket refused by the per-user concurrent socket cap. */
export const TOO_MANY_CONNECTIONS = 'TOO_MANY_CONNECTIONS';

export type HandshakeVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Outcome of `ConnectionCaps.acquireSocket`; release the slot only when `held`. */
export interface SocketSlot {
  /** The socket may open (under the cap, or Redis unusable). */
  readonly admitted: boolean;
  /** A slot was counted for it, to be freed with `releaseSocket` when the socket ends. */
  readonly held: boolean;
}

/** Admitted without counting a slot (Redis unusable). */
const FAILED_OPEN: SocketSlot = Object.freeze({ admitted: true, held: false });

/** Socket.IO and graphql-ws connection caps (spec §11). Both fail open when Redis is unusable. */
@Injectable()
export class ConnectionCaps {
  private readonly logger = new Logger(ConnectionCaps.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly keys: RedisKeyService,
    @Inject(throttleConfig.KEY) private readonly limits: ThrottleConfig,
    private readonly charger: RateLimitCharger,
  ) {
    redis.defineCommand(CONN_COUNT_COMMAND, { numberOfKeys: 1, lua: CONN_COUNT_SCRIPT });
  }

  /**
   * Charges one handshake to the client IP's `ws-handshake` bucket, IPv6 collapsed to the
   * throttler's `ipv6SubnetPrefix` (default /64), like every other per-IP budget.
   */
  async admitHandshake(ip: string | undefined): Promise<HandshakeVerdict> {
    const { wsHandshakeLimit, wsHandshakeTtlMs } = this.limits;
    try {
      const { record } = await this.charger.charge({
        throttler: THROTTLER.WS_HANDSHAKE,
        scope: GLOBAL_SCOPE,
        tracker: this.charger.trackerFor(undefined, ip),
        limit: wsHandshakeLimit,
        ttlMs: wsHandshakeTtlMs,
        blockMs: wsHandshakeTtlMs,
      });
      return record.isBlocked
        ? { ok: false, retryAfterSeconds: record.timeToBlockExpire }
        : { ok: true };
    } catch (error) {
      this.warn(error);
      return { ok: true };
    }
  }

  /**
   * Takes one of the user's `THROTTLE_WS_SOCKETS_PER_USER` socket slots. `admitted: false` when the
   * user already holds them all. `held` says whether a slot was actually counted: a slot admitted
   * because Redis is unusable (fail open) is not, and its caller must never `releaseSocket` it, or
   * the release would free another socket's slot.
   */
  async acquireSocket(userId: string): Promise<SocketSlot> {
    if (this.redis.status !== 'ready') return FAILED_OPEN;
    try {
      const [, admitted] = await this.redis.appConnCount(
        this.slotKey(userId),
        1,
        this.limits.wsSocketsPerUser,
        this.limits.wsSocketTtlMs,
      );
      return admitted === 1 ? { admitted: true, held: true } : { admitted: false, held: false };
    } catch (error) {
      this.warn(error);
      return FAILED_OPEN;
    }
  }

  /**
   * Frees a slot that `acquireSocket` reported `held`. Skipped while Redis is unusable; the
   * counter's safety TTL (`THROTTLE_WS_SOCKET_TTL_MS`) bounds that leak.
   */
  async releaseSocket(userId: string): Promise<void> {
    if (this.redis.status !== 'ready') return;
    try {
      await this.redis.appConnCount(
        this.slotKey(userId),
        -1,
        this.limits.wsSocketsPerUser,
        this.limits.wsSocketTtlMs,
      );
    } catch (error) {
      this.warn(error);
    }
  }

  private slotKey(userId: string): string {
    return this.keys.key('wsconn', hashTag(userId));
  }

  private warn(error: unknown): void {
    this.logger.warn(
      `connection caps bypassed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
