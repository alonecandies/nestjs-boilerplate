import { type RedisConfig, redisConfig } from '@app/config';
import { Inject, Injectable } from '@nestjs/common';
import { joinKey, type RedisKeyPart } from './key.util.js';

/**
 * Builds namespaced keys `${REDIS_KEY_PREFIX}:…` so several apps/environments can share one Redis.
 * Conventions (blueprint §6): `auth:denylist:{jti}`, `lock:{resource}`, `throttle:{name:tracker}`.
 */
@Injectable()
export class RedisKeyService {
  /** The configured `REDIS_KEY_PREFIX` (without trailing separator). */
  readonly prefix: string;

  constructor(@Inject(redisConfig.KEY) config: RedisConfig) {
    this.prefix = config.keyPrefix;
  }

  /** `prefix:part1:part2…` — see `joinKey`. */
  key(...parts: readonly RedisKeyPart[]): string {
    return joinKey(this.prefix, ...parts);
  }
}
