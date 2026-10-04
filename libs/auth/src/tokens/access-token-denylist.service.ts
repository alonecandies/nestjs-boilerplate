import { ServiceUnavailableException, withTimeout } from '@app/common';
import { type AuthConfig, authConfig } from '@app/config';
import { InjectRedis, RedisKeyService } from '@app/redis';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { DENYLIST_CHECK_TIMEOUT_MS, JWT_CLOCK_TOLERANCE_SEC } from '../auth.constants.js';

/**
 * Revoked access tokens (logout, admin "log out everywhere"): `${prefix}:auth:denylist:{jti}`
 * with a TTL equal to the token's remaining lifetime (+ clock tolerance), so the set never grows
 * beyond the tokens that are still valid. Checked on every authenticated request — one EXISTS,
 * auto-pipelined by ioredis, bounded to `DENYLIST_CHECK_TIMEOUT_MS` (250 ms).
 *
 * Fails CLOSED: if Redis cannot answer in time (error, or a command parked in ioredis' offline
 * queue while it reconnects), authenticated requests get 503 rather than silently accepting a
 * possibly revoked token. `AUTH_DENYLIST_ENABLED=false` turns it into a no-op.
 */
@Injectable()
export class AccessTokenDenylist {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly keys: RedisKeyService,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
  ) {}

  get enabled(): boolean {
    return this.config.denylistEnabled;
  }

  /**
   * Revokes `jti` for as long as verifiers could still accept the token (`exp` + clock
   * tolerance). No-op for tokens that can no longer be accepted anyway.
   */
  async deny(jti: string, expEpochSec: number): Promise<void> {
    if (!this.enabled) return;
    const ttlSec = Math.ceil(expEpochSec - Date.now() / 1_000) + JWT_CLOCK_TOLERANCE_SEC;
    if (ttlSec <= 0) return;
    await this.redis.set(this.key(jti), '1', 'EX', ttlSec);
  }

  async isDenied(jti: string): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const count = await withTimeout(
        this.redis.exists(this.key(jti)),
        DENYLIST_CHECK_TIMEOUT_MS,
        'Token revocation check timed out',
      );
      return count === 1;
    } catch (error) {
      throw new ServiceUnavailableException('Token revocation check is temporarily unavailable', {
        cause: error,
      });
    }
  }

  private key(jti: string): string {
    return this.keys.key('auth', 'denylist', jti);
  }
}
