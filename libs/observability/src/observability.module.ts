import { type ObservabilityConfig, observabilityConfig } from '@app/config';
import { type DynamicModule, Module, type Type } from '@nestjs/common';
import { RequestContextModule } from './context/request-context.module.js';
import { HealthModule } from './health/health.module.js';
import type { HealthContributor } from './health/health-contributor.js';
import { AppLoggerModule } from './logging/logger.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { DEFAULT_READINESS_TIMEOUT_MS } from './observability.constants.js';
import { buildObserveOptions, isObserveEnabled, ObserveModule } from './observe/observe.js';
import { TelemetryFlushService } from './shutdown/telemetry-flush.service.js';
import { TracingModule } from './tracing/tracing.module.js';

export interface ObservabilityModuleOptions {
  /**
   * Readiness dependencies checked by `GET /health/ready`, e.g.
   * `[DatabaseHealthIndicator, RedisHealthIndicator, KafkaHealthIndicator]`. The instances their
   * infra modules export are reused; unprovided classes are instantiated with DI.
   */
  healthContributors?: readonly Type<HealthContributor>[];
  /** Budget per readiness contributor (ms). Default 3000. */
  readinessTimeoutMs?: number;
  /**
   * After SIGTERM, keep serving while readiness reports 503 `shutting_down` for this long (ms), so
   * load balancers stop routing before the server closes. Default 0; ~5000 behind k8s Services.
   */
  shutdownDrainMs?: number;
  /** Include failure messages in readiness responses. Default: not in production. */
  exposeHealthDetails?: boolean;
  /**
   * Wire `@nestjs/observe`. Default: both `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` are set.
   * Pair with `observeInstrument()` in `NestFactory.create` (done by `@app/bootstrap`).
   */
  observe?: boolean;
}

/**
 * Everything a process needs to be observable, imported ONCE by every app root module (after
 * `AppConfigModule.forRoot()`, whose global `app`/`observability` namespaces it injects):
 *
 * - pino JSON logs via nestjs-pino (`Logger` for `app.useLogger`, `PinoLogger`), with `requestId`
 *   and `trace_id`/`span_id` on every line;
 * - nestjs-cls request context (`RequestContextService`) for HTTP, GraphQL, gRPC, Kafka and WS;
 * - Prometheus `/metrics` + `http_request_duration_seconds{method,route,status_code}`;
 * - terminus `/health/live` + `/health/ready` over the given `HealthContributor`s;
 * - nestjs-otel tracing helpers (`TraceService`, `@Span()`), telemetry flush on shutdown;
 * - `@nestjs/observe`, only when its credentials are configured.
 *
 * Global, so `RequestContextService`, terminus' `HealthIndicatorService` and the metric providers
 * resolve everywhere.
 */
@Module({})
export class ObservabilityModule {
  static forRoot(options: ObservabilityModuleOptions = {}): DynamicModule {
    // Decided at module-definition time: whether the ObserveModule exists at all can't depend on
    // DI. Reads the same env the `observability` namespace validates.
    const observe = options.observe ?? isObserveEnabled();
    return {
      module: ObservabilityModule,
      global: true,
      imports: [
        AppLoggerModule,
        RequestContextModule,
        MetricsModule,
        HealthModule.register({
          contributors: options.healthContributors ?? [],
          readinessTimeoutMs: options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
          shutdownDrainMs: options.shutdownDrainMs ?? 0,
          ...(options.exposeHealthDetails === undefined
            ? {}
            : { exposeDetails: options.exposeHealthDetails }),
        }),
        TracingModule,
        ...(observe
          ? [
              ObserveModule.forRootAsync({
                inject: [observabilityConfig.KEY],
                useFactory: (config: ObservabilityConfig) => buildObserveOptions(config),
              }),
            ]
          : []),
      ],
      providers: [TelemetryFlushService],
      exports: [RequestContextModule, HealthModule],
    };
  }
}
