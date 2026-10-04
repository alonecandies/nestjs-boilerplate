import { type ObservabilityConfig, observabilityConfig } from '@app/config';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type AbstractHttpAdapter, HttpAdapterHost } from '@nestjs/core';
import { trace } from '@opentelemetry/api';
import { ATTR_HTTP_ROUTE } from '@opentelemetry/semantic-conventions';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isNil } from 'lodash-es';
import { Histogram } from 'prom-client';
import { isTracingActive } from '../otel.js';
import {
  type HTTP_METRIC_LABEL_NAMES,
  HTTP_REQUEST_DURATION_SECONDS,
  METRICS_PATH,
  UNMATCHED_ROUTE,
} from './metrics.constants.js';

/** `{ method, route, status_code }` — a type alias (not an interface) so it fits prom-client's label map. */
export type HttpMetricLabels = Record<(typeof HTTP_METRIC_LABEL_NAMES)[number], string>;

/** The slice of a Fastify instance the hook needs (a real `FastifyInstance` in apps and tests). */
export type HttpMetricsTarget = Pick<FastifyInstance, 'addHook'>;

/**
 * Labels of one observation. `route` is the matched route TEMPLATE (`/v1/users/:id`), never the
 * raw URL: raw paths carry ids and would create a new time series per entity (cardinality blow-up
 * that eventually OOMs Prometheus). Unmatched requests share one `UNMATCHED` series.
 */
export function httpMetricLabels(
  method: string,
  routeTemplate: string | undefined,
  statusCode: number,
): HttpMetricLabels {
  return {
    method,
    route: routeTemplate ?? UNMATCHED_ROUTE,
    status_code: String(statusCode),
  };
}

/**
 * Records `http_request_duration_seconds{method,route,status_code}` from Fastify's `onResponse`
 * hook (`reply.elapsedTime`). A Fastify hook rather than a Nest interceptor because it sees EVERY
 * response — 404s, guard rejections (401/403), throttling (429), body-parser errors and the final
 * status chosen by exception filters — which a Nest interceptor never observes (research
 * integrations §8). GraphQL over HTTP lands on the `/graphql` route; WebSocket and RPC traffic is
 * not HTTP and is not recorded here.
 *
 * Installed in `onModuleInit`: Fastify binds root hooks to routes at `preReady`, i.e. after Nest
 * registered its routes, so every route (and the 404 handler) gets them.
 *
 * When tracing runs it also names the HTTP server span `GET /v1/users/:id` + `http.route`, since no
 * OpenTelemetry instrumentation understands Nest 12 / Fastify 5 routes (research integrations §9.2).
 */
@Injectable()
export class HttpMetricsHook implements OnModuleInit {
  private readonly logger = new Logger(HttpMetricsHook.name);

  constructor(
    @InjectMetric(HTTP_REQUEST_DURATION_SECONDS) private readonly duration: Histogram,
    private readonly adapterHost: HttpAdapterHost,
    @Inject(observabilityConfig.KEY) private readonly config: ObservabilityConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.metricsEnabled) return;
    // null in standalone application contexts (no HTTP server).
    const adapter = this.adapterHost.httpAdapter as AbstractHttpAdapter | null | undefined;
    if (isNil(adapter)) return;
    if (adapter.getType() !== 'fastify') {
      this.logger.warn(`HTTP metrics need the Fastify adapter (got "${adapter.getType()}")`);
      return;
    }
    this.install(adapter.getInstance<FastifyInstance>(), { nameSpans: isTracingActive() });
  }

  /** Adds the hooks to a Fastify instance (before `ready()`). Exposed for tests. */
  install(fastify: HttpMetricsTarget, options: { nameSpans?: boolean } = {}): void {
    // Callback-style hooks: no promise allocation per request on the hottest path.
    fastify.addHook(
      'onResponse',
      (request: FastifyRequest, reply: FastifyReply, done: () => void): void => {
        const route = request.routeOptions.url;
        if (route !== METRICS_PATH) {
          this.duration.observe(
            httpMetricLabels(request.method, route, reply.statusCode),
            reply.elapsedTime / 1_000,
          );
        }
        done();
      },
    );

    // Only when an SDK is running: otherwise the hook would cost a lookup per request for nothing.
    if (options.nameSpans === true) {
      fastify.addHook(
        'onRequest',
        (request: FastifyRequest, _reply: FastifyReply, done: () => void): void => {
          const route = request.routeOptions.url;
          const span = route === undefined ? undefined : trace.getActiveSpan();
          if (span !== undefined && route !== undefined) {
            span.updateName(`${request.method} ${route}`);
            span.setAttribute(ATTR_HTTP_ROUTE, route);
          }
          done();
        },
      );
    }
  }
}
