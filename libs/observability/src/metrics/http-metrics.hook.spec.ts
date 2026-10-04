import type { ObservabilityConfig } from '@app/config';
import type { HttpAdapterHost } from '@nestjs/core';
import fastify, { type FastifyInstance } from 'fastify';
import { Histogram, Registry } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpMetricsHook, httpMetricLabels } from './http-metrics.hook.js';
import {
  HTTP_DURATION_BUCKETS,
  HTTP_METRIC_LABEL_NAMES,
  HTTP_REQUEST_DURATION_SECONDS,
} from './metrics.constants.js';

describe('httpMetricLabels', () => {
  it('uses the route template and a string status code', () => {
    expect(httpMetricLabels('GET', '/v1/users/:id', 200)).toEqual({
      method: 'GET',
      route: '/v1/users/:id',
      status_code: '200',
    });
  });

  it('collapses unmatched requests into one series', () => {
    expect(httpMetricLabels('GET', undefined, 404).route).toBe('UNMATCHED');
  });
});

describe('HttpMetricsHook', () => {
  let registry: Registry;
  let histogram: Histogram;
  let app: FastifyInstance;

  const hookFor = (metricsEnabled = true): HttpMetricsHook =>
    new HttpMetricsHook(
      histogram,
      { httpAdapter: null } as unknown as HttpAdapterHost,
      { metricsEnabled } as ObservabilityConfig,
    );

  /** `{ labels → count }` of the histogram's `_count` series. */
  async function counts(): Promise<Record<string, number>> {
    const metric = await histogram.get();
    return Object.fromEntries(
      metric.values
        .filter((value) => value.metricName === `${HTTP_REQUEST_DURATION_SECONDS}_count`)
        .map((value) => [
          `${String(value.labels['method'])} ${String(value.labels['route'])} ${String(value.labels['status_code'])}`,
          value.value,
        ]),
    );
  }

  beforeEach(async () => {
    registry = new Registry();
    histogram = new Histogram({
      name: HTTP_REQUEST_DURATION_SECONDS,
      help: 'test',
      labelNames: [...HTTP_METRIC_LABEL_NAMES],
      buckets: [...HTTP_DURATION_BUCKETS],
      registers: [registry],
    });
    app = fastify();
    hookFor().install(app);
    app.get('/v1/users/:id', async (request) => ({ id: (request.params as { id: string }).id }));
    app.get('/v1/forbidden', async (_request, reply) => reply.code(403).send({ denied: true }));
    app.get('/metrics', async () => 'scrape');
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('records the route TEMPLATE, not the raw URL (low cardinality)', async () => {
    await app.inject({ method: 'GET', url: '/v1/users/1' });
    await app.inject({ method: 'GET', url: '/v1/users/2?expand=true' });
    expect(await counts()).toEqual({ 'GET /v1/users/:id 200': 2 });
  });

  it('records statuses a Nest interceptor never sees (404, guard-style 403)', async () => {
    await app.inject({ method: 'GET', url: '/does-not-exist/123' });
    await app.inject({ method: 'GET', url: '/v1/forbidden' });
    expect(await counts()).toEqual({
      'GET UNMATCHED 404': 1,
      'GET /v1/forbidden 403': 1,
    });
  });

  it('does not record the Prometheus scrape itself', async () => {
    await app.inject({ method: 'GET', url: '/metrics' });
    expect(await counts()).toEqual({});
  });

  it('observes durations in seconds', async () => {
    await app.inject({ method: 'GET', url: '/v1/users/1' });
    const sum = (await histogram.get()).values.find(
      (value) => value.metricName === `${HTTP_REQUEST_DURATION_SECONDS}_sum`,
    );
    expect(sum?.value).toBeGreaterThan(0);
    expect(sum?.value).toBeLessThan(5);
  });

  it('is a no-op when metrics are disabled or there is no HTTP server (application context)', () => {
    expect(() => hookFor(false).onModuleInit()).not.toThrow();
    expect(() => hookFor(true).onModuleInit()).not.toThrow();
  });
});
