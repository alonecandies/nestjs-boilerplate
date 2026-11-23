import { Inject, Injectable, Logger } from '@nestjs/common';
import { generateId } from '@platform/common';
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

/**
 * Outcome of `ConnectionCaps.acquireSocket`. An admitted socket (under the cap, or Redis
 * unusable) carries its slot `id`, generated per acquire: pass it to `releaseSocket` when the
 * socket ends, whether or not Redis counted the slot.
 */
export type SocketSlot =
  | { readonly admitted: true; readonly id: string }
  | { readonly admitted: false };

/**
 * Added to the token's expiry in a slot's deadline, for clock skew between replicas and Redis.
 * Both transports close a socket when its token expires, so its slot outlives it.
 */
const TOKEN_EXPIRY_GRACE_MS = 60_000;

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
   * Takes one of the user's `THROTTLE_WS_SOCKETS_PER_USER` socket slots for a socket whose access
   * token expires at `tokenExpSec` (epoch seconds, the token's `exp`). `admitted: false` when the
   * user already holds them all.
   * - Each slot lives until its deadline, max(now + `THROTTLE_WS_SOCKET_TTL_MS`, token expiry +
   *   60 s), unless released first. A slot that is never released (crashed replica, lost
   *   release) frees itself then, and a live socket never outlives its slot.
   * - Fails open (admitted) when Redis is unusable. The slot may still have been counted (the
   *   reply was lost), so the caller releases every admitted slot all the same.
   */
  async acquireSocket(userId: string, tokenExpSec: number): Promise<SocketSlot> {
    const id = generateId();
    if (this.redis.status !== 'ready') return { admitted: true, id };
    try {
      const admitted = await this.redis.appConnSlot(
        this.slotKey(userId),
        id,
        this.limits.wsSocketsPerUser,
        this.limits.wsSocketTtlMs,
        Math.floor(tokenExpSec * 1_000) + TOKEN_EXPIRY_GRACE_MS,
      );
      return admitted === 1 ? { admitted: true, id } : { admitted: false };
    } catch (error) {
      this.warn(error);
      return { admitted: true, id };
    }
  }

  /**
   * Frees the slot `acquireSocket` admitted with `slotId`. Idempotent: a resent, late or
   * duplicate release removes only that slot, and a slot that was never counted frees nothing. A
   * release that fails leaves the slot until its deadline.
   */
  async releaseSocket(userId: string, slotId: string): Promise<void> {
    try {
      await this.redis.zrem(this.slotKey(userId), slotId);
    } catch (error) {
      this.warn(error);
    }
  }

  /** One sorted set per user (a new key name: the old `wsconn` counter expires on its own). */
  private slotKey(userId: string): string {
    return this.keys.key('wsslot', hashTag(userId));
  }

  private warn(error: unknown): void {
    this.logger.warn(
      `connection caps bypassed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
