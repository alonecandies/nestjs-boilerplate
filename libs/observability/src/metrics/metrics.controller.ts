import { Public } from '@app/common';
import { type ObservabilityConfig, observabilityConfig } from '@app/config';
import { Controller, Get, Inject, NotFoundException, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { PrometheusController } from '@willsoto/nestjs-prometheus';
import type { FastifyReply } from 'fastify';
import { register } from 'prom-client';
import { requestClusterMetrics } from './cluster-metrics.js';

/**
 * `GET /metrics` (Prometheus text format). VERSION_NEUTRAL (no `/v1`), `@Public()` (auth guards
 * skip it; the throttler skips ops paths), excluded from its own latency histogram. Behind
 * `runClustered()` it serves the cluster-wide aggregate (see `cluster-metrics.ts`).
 *
 * Returns 404 when `METRICS_ENABLED=false` — the route itself can't be conditional, because
 * controllers are fixed before config is resolved.
 */
@Public()
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
export class MetricsController extends PrometheusController {
  constructor(@Inject(observabilityConfig.KEY) private readonly config: ObservabilityConfig) {
    super();
  }

  @Get()
  override async index(@Res({ passthrough: true }) response: FastifyReply): Promise<string> {
    if (!this.config.metricsEnabled) throw new NotFoundException();
    const aggregated = await requestClusterMetrics();
    if (aggregated !== undefined) {
      response.header('Content-Type', register.contentType);
      return aggregated;
    }
    return super.index(response);
  }
}
