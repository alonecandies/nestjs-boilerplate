import { HealthContributor } from '@app/observability';
import { Injectable } from '@nestjs/common';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { InjectCassandra } from '../cassandra.constants.js';
import type { CassandraClient } from '../cassandra.types.js';

/** Below the readiness endpoint's per-contributor budget (3 s) → a precise `down` for this key. */
const PING_TIMEOUT_MS = 2_000;

const PING_CQL = 'SELECT release_version FROM system.local';

/**
 * Readiness contributor `cassandra`: a single-partition read of `system.local` on the
 * coordinator — proves a pooled connection to a live node without touching application tables.
 * CQL requests can't be cancelled, so the driver-side `readTimeout` bounds the attempt too.
 */
@Injectable()
export class CassandraHealthIndicator extends HealthContributor {
  override readonly key = 'cassandra';

  constructor(
    @InjectCassandra() private readonly client: CassandraClient,
    private readonly health: HealthIndicatorService,
  ) {
    super();
  }

  override async check(): Promise<HealthIndicatorResult> {
    return this.health
      .check(this.key)
      .attempt(async () => {
        await this.client.execute(PING_CQL, [], {
          prepare: true,
          isIdempotent: true,
          readTimeout: PING_TIMEOUT_MS,
        });
      })
      .withTimeout(PING_TIMEOUT_MS);
  }
}
