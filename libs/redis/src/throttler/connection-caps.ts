import { Inject, Injectable, Logger } from '@nestjs/common';
import { normalizeIp } from '@nestjs/throttler';
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

  /** Charges one handshake to the client IP's `ws-handshake` bucket (IPv6 collapsed to its /64). */
  async admitHandshake(ip: string | undefined): Promise<HandshakeVerdict> {
    const { wsHandshakeLimit, wsHandshakeTtlMs } = this.limits;
    try {
      const { record } = await this.charger.charge({
        throttler: THROTTLER.WS_HANDSHAKE,
        scope: GLOBAL_SCOPE,
        tracker: ip ? `ip:${normalizeIp(ip, 64)}` : 'ip:unknown',
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

  /** `false` when the user already has `THROTTLE_WS_SOCKETS_PER_USER` open sockets. */
  async acquireSocket(userId: string): Promise<boolean> {
    return (await this.count(userId, 1)) !== 0;
  }

  async releaseSocket(userId: string): Promise<void> {
    await this.count(userId, -1);
  }

  /** 1 = admitted (or failed open), 0 = refused. */
  private async count(userId: string, delta: 1 | -1): Promise<0 | 1> {
    if (this.redis.status !== 'ready') return 1;
    const key = this.keys.key('wsconn', hashTag(userId));
    try {
      const [, admitted] = await this.redis.appConnCount(
        key,
        delta,
        this.limits.wsSocketsPerUser,
        this.limits.wsSocketTtlMs,
      );
      return admitted === 1 ? 1 : 0;
    } catch (error) {
      this.warn(error);
      return 1;
    }
  }

  private warn(error: unknown): void {
    this.logger.warn(
      `connection caps bypassed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
