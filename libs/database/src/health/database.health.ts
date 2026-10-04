import { HealthContributor } from '@app/observability';
import { Injectable } from '@nestjs/common';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import type { DrizzleDB } from '../drizzle/drizzle.types.js';
import { InjectDrizzle } from '../drizzle/inject-drizzle.decorator.js';

/**
 * Below the readiness endpoint's per-contributor budget (3 s) so a slow database reports a
 * precise `down` for `postgres` instead of a generic timeout.
 */
const PING_TIMEOUT_MS = 2_000;

/**
 * Readiness contributor `postgres`: a raw `select 1` through the shared pool. It goes through
 * the pool on purpose — an exhausted pool IS "not ready" — and cancels the query when the
 * attempt times out so it does not keep occupying a connection.
 */
@Injectable()
export class DatabaseHealthIndicator extends HealthContributor {
  override readonly key = 'postgres';

  constructor(
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly health: HealthIndicatorService,
  ) {
    super();
  }

  override async check(): Promise<HealthIndicatorResult> {
    return this.health
      .check(this.key)
      .attempt(async ({ signal }) => {
        const query = this.db.$client`select 1`;
        const cancel = (): void => void query.cancel();
        signal.addEventListener('abort', cancel, { once: true });
        try {
          await query;
        } finally {
          signal.removeEventListener('abort', cancel);
        }
      })
      .withTimeout(PING_TIMEOUT_MS);
  }
}
