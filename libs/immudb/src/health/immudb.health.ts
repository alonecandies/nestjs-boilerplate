import { Injectable } from '@nestjs/common';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { HealthContributor } from '@platform/observability';
import { ImmudbSessionPool } from '../client/session-pool.js';

/** Below the readiness endpoint's per-contributor budget (3 s). */
const PING_TIMEOUT_MS = 2_000;

/** Readiness contributor `immudb`: the `Health` RPC on a pooled session. */
@Injectable()
export class ImmudbHealthIndicator extends HealthContributor {
  override readonly key = 'immudb';

  constructor(
    private readonly pool: ImmudbSessionPool,
    private readonly health: HealthIndicatorService,
  ) {
    super();
  }

  override async check(): Promise<HealthIndicatorResult> {
    return this.health
      .check(this.key)
      .attempt(async () => {
        const response = await this.pool.use((session) => session.health());
        if (!response.status) throw new Error('immudb reports itself unhealthy');
      })
      .withTimeout(PING_TIMEOUT_MS);
  }
}
