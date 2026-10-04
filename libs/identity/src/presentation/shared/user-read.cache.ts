import type { User } from '@app/contracts';
import { AppCacheService } from '@app/redis';
import { Injectable, Logger } from '@nestjs/common';
import { UsersPort } from '../../application/ports/users.port.js';
import { USER_CACHE_TTL_MS, userCacheKey } from '../../identity.constants.js';
import { reviveUser } from './user-view.js';

/**
 * Edge read-through cache of single users (`user:{id}`, 30 s, L1 in-process + L2 Redis via
 * `AppCacheService`, concurrent misses coalesced). It lives in the presentation layer on purpose:
 * in the microservice topology the cache sits in the gateway, in front of the gRPC hop. Writes
 * that change what a profile shows (role changes) call `invalidate()`, which also evicts every
 * replica's L1 copy.
 */
@Injectable()
export class UserReadCache {
  private readonly logger = new Logger(UserReadCache.name);

  constructor(
    private readonly cache: AppCacheService,
    private readonly users: UsersPort,
  ) {}

  async getUser(id: string): Promise<User> {
    const user = await this.cache.getOrSet(
      userCacheKey(id),
      () => this.users.getUser(id),
      USER_CACHE_TTL_MS,
    );
    return reviveUser(user);
  }

  /** Best effort: the write already happened, a cache outage must not turn it into a 500. */
  async invalidate(id: string): Promise<void> {
    try {
      await this.cache.del(userCacheKey(id));
    } catch (error) {
      this.logger.warn({ err: error, userId: id }, 'User cache invalidation failed');
    }
  }
}
