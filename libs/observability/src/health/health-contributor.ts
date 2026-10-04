import type { HealthIndicatorResult } from '@nestjs/terminus';

/**
 * A readiness dependency (Postgres, Redis, Cassandra, Kafka…). Infra libs implement it next to the
 * client they own — usually with terminus' `HealthIndicatorService.check(key).attempt(...)` — and
 * the app lists the classes in `ObservabilityModule.forRoot({ healthContributors: [...] })`.
 *
 * `GET /health/ready` runs every contributor in parallel under a per-contributor timeout; a throw,
 * a rejection or a timeout counts as `down`, so implementations don't need their own try/catch.
 * An abstract class so it can also serve as a DI token. The registry resolves contributors by the
 * listed class and never `instanceof`-checks them, so both `extends HealthContributor` and
 * `implements HealthContributor` (with `import type` — keeps this package off a lib's runtime
 * import graph, as `@app/redis` and `@app/transport` do) are valid.
 */
export abstract class HealthContributor {
  /** Result key in the health payload (`postgres`, `redis`, …); unique per app. */
  abstract readonly key: string;

  abstract check(): Promise<HealthIndicatorResult>;
}
