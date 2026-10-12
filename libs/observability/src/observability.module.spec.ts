import { type INestApplicationContext, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { AppConfigModule } from '@platform/config';
import { TraceService } from 'nestjs-otel';
import { Logger, PARAMS_PROVIDER_TOKEN, type Params, PinoLogger } from 'nestjs-pino';
import type { Options as PinoHttpOptions } from 'pino-http';
import { register } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestContextService } from './context/request-context.service.js';
import { HealthContributor } from './health/health-contributor.js';
import { HealthContributorRegistry } from './health/health-contributor.registry.js';
import { LOG_REDACT_PATHS } from './logging/logger-params.js';
import { HTTP_REQUEST_DURATION_SECONDS } from './metrics/metrics.constants.js';
import { MetricsController } from './metrics/metrics.controller.js';
import { ObservabilityModule } from './observability.module.js';
import { ObserveModule } from './observe/observe.js';
import { TelemetryFlushService } from './shutdown/telemetry-flush.service.js';

@Injectable()
class QueueContributor extends HealthContributor {
  override readonly key = 'queue';

  constructor(private readonly health: HealthIndicatorService) {
    super();
  }

  override check(): Promise<HealthIndicatorResult> {
    return Promise.resolve(this.health.check(this.key).up());
  }
}

describe('ObservabilityModule', () => {
  let app: INestApplicationContext;

  beforeAll(async () => {
    process.env['LOG_LEVEL'] = 'silent';
    @Module({
      imports: [
        AppConfigModule.forRoot(),
        ObservabilityModule.forRoot({
          observe: false,
          healthContributors: [QueueContributor],
          redactPaths: ['req.headers["x-webhook-signature"]'],
        }),
      ],
    })
    class AppModule {}
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  });

  afterAll(async () => {
    await app.close();
  });

  it('provides logging, request context, tracing helpers and the flush hook globally', async () => {
    expect(app.get(Logger)).toBeInstanceOf(Logger);
    // transient-scoped: one per injecting class
    expect(await app.resolve(PinoLogger)).toBeInstanceOf(PinoLogger);
    expect(app.get(RequestContextService)).toBeInstanceOf(RequestContextService);
    expect(app.get(TraceService)).toBeInstanceOf(TraceService);
    expect(app.get(TelemetryFlushService)).toBeInstanceOf(TelemetryFlushService);
    // terminus is re-exported so contributors declared anywhere can inject it
    expect(app.get(HealthIndicatorService)).toBeInstanceOf(HealthIndicatorService);
  });

  it('resolves the configured health contributors', () => {
    const keys = app.get(HealthContributorRegistry).contributors.map(({ key }) => key);
    expect(keys).toEqual(['queue']);
  });

  it('hands the app-supplied redact paths to the pino logger', () => {
    const { pinoHttp } = app.get<Params>(PARAMS_PROVIDER_TOKEN);

    expect((pinoHttp as PinoHttpOptions).redact).toEqual({
      paths: [...LOG_REDACT_PATHS, 'req.headers["x-webhook-signature"]'],
      censor: '[REDACTED]',
    });
  });

  it('registers the metrics controller, the latency histogram and default metrics', async () => {
    expect(app.get(MetricsController, { strict: false })).toBeInstanceOf(MetricsController);
    expect(register.getSingleMetric(HTTP_REQUEST_DURATION_SECONDS)).toBeDefined();
    expect(await register.metrics()).toContain('nodejs_eventloop_lag_p99_seconds');
  });

  it('only wires @nestjs/observe when asked to (or configured)', () => {
    const hasObserve = (observe: boolean): boolean =>
      (ObservabilityModule.forRoot({ observe }).imports ?? []).some(
        (imported) =>
          typeof imported === 'object' && 'module' in imported && imported.module === ObserveModule,
      );
    expect(hasObserve(false)).toBe(false);
    expect(hasObserve(true)).toBe(true);
  });
});
