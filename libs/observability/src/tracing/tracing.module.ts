import { Module } from '@nestjs/common';
import { OpenTelemetryModule } from 'nestjs-otel';

/**
 * nestjs-otel helpers (internal to `ObservabilityModule`): `TraceService`, `@Span()`,
 * `@Traceable()`. Tracing only — prom-client owns metrics, so no OTel host metrics. The SDK itself
 * is started by `startTracing()` (`@app/observability/otel`) before Nest loads; without it these
 * helpers use the no-op tracer.
 *
 * Manual spans matter here: the OTel instrumentations for @nestjs/core and graphql don't support
 * Nest 12 / graphql 17 yet and postgres.js has none (research integrations §9.2), so repositories,
 * resolvers and CQRS handlers should be annotated with `@Span()` / `@Traceable()`.
 */
@Module({
  imports: [OpenTelemetryModule.forRoot({ metrics: { hostMetrics: false } })],
})
export class TracingModule {}

export { CurrentSpan, Span, Traceable, TraceService } from 'nestjs-otel';
