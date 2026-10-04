import type { HealthContributor } from '@app/observability';
import { Injectable } from '@nestjs/common';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import type { Redis } from 'ioredis';
import { round } from 'lodash-es';
import { InjectRedis } from '../redis.constants.js';

/** Per-check budget; the readiness endpoint adds its own overall timeout on top. */
const PING_TIMEOUT_MS = 1_000;
/** Collapses probe storms (kubelet + LB + humans) into at most one PING per second. */
const RESULT_CACHE_MS = 1_000;

/**
 * Readiness contributor for the shared Redis connection (`key: 'redis'`): `down` immediately when
 * the client is not `ready` (reconnecting) instead of queueing a PING behind the offline queue.
 * Register it with `ObservabilityModule.forRoot({ healthContributors: [RedisHealthIndicator] })`.
 */
@Injectable()
export class RedisHealthIndicator implements HealthContributor {
  readonly key = 'redis';

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly health: HealthIndicatorService,
  ) {}

  async check(): Promise<HealthIndicatorResult> {
    return this.health
      .check(this.key)
      .attempt(async () => {
        if (this.redis.status !== 'ready') {
          throw new Error(`connection is ${this.redis.status}`);
        }
        const startedAt = performance.now();
        await this.redis.ping();
        return { latencyMs: round(performance.now() - startedAt, 2) };
      })
      .withTimeout(PING_TIMEOUT_MS)
      .cacheFor(RESULT_CACHE_MS);
  }
}
