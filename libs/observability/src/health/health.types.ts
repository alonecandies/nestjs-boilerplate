import type { Type } from '@nestjs/common';
import type { HealthContributor } from './health-contributor.js';

/** Readiness settings (`HEALTH_OPTIONS`), resolved once at boot. */
export interface ResolvedHealthOptions {
  contributors: readonly Type<HealthContributor>[];
  /** Budget per contributor; slower = `down`. */
  readinessTimeoutMs: number;
  /**
   * Include failure messages in `/health/ready` responses. Off in production: they leak internal
   * hostnames/IPs and driver errors on a public port. Failures are always logged.
   */
  exposeDetails: boolean;
}
