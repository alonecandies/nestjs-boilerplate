import { CorrelationIdMiddleware, HTTP_HEADERS, isUuidV7 } from '@app/common';
import { AppConfigModule, appConfig } from '@app/config';
import { HealthContributor, ObservabilityModule, RequestContextService } from '@app/observability';
import {
  Controller,
  Get,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFastifyOptions, createHttpApp } from './create-http-app.js';
import { listen } from './listen.js';

process.env['LOG_LEVEL'] = 'silent';

@Controller('ping')
class PingController {
  constructor(private readonly context: RequestContextService) {}

  @Get()
  ping(): { requestId: string | undefined } {
    return { requestId: this.context.requestId };
  }
}

@Module({
  imports: [AppConfigModule.forRoot(), ObservabilityModule.forRoot({ observe: false })],
  controllers: [PingController],
})
class SmokeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorrelationIdMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}

describe('createHttpApp (smoke, no infrastructure)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createHttpApp(SmokeModule, { processHandlers: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves GET /health/live (VERSION_NEUTRAL, no auth, no-cache)', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', info: {}, error: {}, details: {} });
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('serves GET /health/ready with no contributors', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('versions app routes under /v1', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/ping' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/ping' })).statusCode).toBe(404);
  });

  it('shares ONE request id between Fastify, nestjs-cls and the response header', async () => {
    const adopted = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { [HTTP_HEADERS.REQUEST_ID]: 'req-abc.123' },
    });
    expect(adopted.json()).toEqual({ requestId: 'req-abc.123' });
    expect(adopted.headers[HTTP_HEADERS.REQUEST_ID]).toBe('req-abc.123');

    // An unsafe incoming id is replaced, not echoed.
    const replaced = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { [HTTP_HEADERS.REQUEST_ID]: 'bad id <script>' },
    });
    const { requestId } = replaced.json<{ requestId: string }>();
    expect(isUuidV7(requestId)).toBe(true);
    expect(replaced.headers[HTTP_HEADERS.REQUEST_ID]).toBe(requestId);
  });

  it('exposes Prometheus metrics with low-cardinality route labels', async () => {
    await app.inject({ method: 'GET', url: '/v1/ping' });
    await app.inject({ method: 'GET', url: '/nope/42' });

    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    const body = response.body;
    expect(body).toMatch(
      /http_request_duration_seconds_count\{method="GET",route="\/v1\/ping",status_code="200"\} \d+/,
    );
    expect(body).toMatch(
      /http_request_duration_seconds_count\{method="GET",route="UNMATCHED",status_code="404"\} \d+/,
    );
    expect(body).not.toContain('/nope/42');
    expect(body).not.toContain('route="/metrics"');
    expect(body).toContain('process_resident_memory_bytes');
  });

  it('applies helmet and compression', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'accept-encoding': 'br' },
    });
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-encoding']).toBe('br');
  });

  it('answers CORS preflights for configured origins only', async () => {
    const preflight = (origin: string) =>
      app.inject({
        method: 'OPTIONS',
        url: '/v1/ping',
        headers: { origin, 'access-control-request-method': 'GET' },
      });
    const allowed = await preflight('http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    const denied = await preflight('https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

@Injectable()
class BrokerContributor extends HealthContributor {
  override readonly key = 'broker';

  override check(): never {
    throw new Error('broker unreachable');
  }
}

@Module({
  imports: [
    AppConfigModule.forRoot(),
    ObservabilityModule.forRoot({ observe: false, healthContributors: [BrokerContributor] }),
  ],
})
class UnhealthyModule {}

describe('readiness over HTTP', () => {
  it('answers 503 with the terminus body when a dependency is down', async () => {
    const app = await createHttpApp(UnhealthyModule, { processHandlers: false });
    try {
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      const ready = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({
        status: 'error',
        error: { broker: { status: 'down', message: 'broker unreachable' } },
      });
      // Liveness must not follow dependencies.
      expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('listen', () => {
  it('binds HOST/PORT (port 0 → free port) and returns the URL', async () => {
    const app = await createHttpApp(SmokeModule, { processHandlers: false });
    try {
      const url = await listen(app, { host: '127.0.0.1', port: 0 });
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const response = await fetch(`${url}/health/live`);
      expect(response.status).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('buildFastifyOptions', () => {
  const config = appConfig.parse({ NODE_ENV: 'production', BODY_LIMIT_BYTES: '2048' });

  it('maps the app config and never trusts the raw x-request-id header', () => {
    const options = buildFastifyOptions(config);
    expect(options).toMatchObject({
      bodyLimit: 2048,
      keepAliveTimeout: 72_000,
      requestTimeout: 30_000,
      trustProxy: true,
      requestIdHeader: false,
      forceCloseConnections: 'idle',
      return503OnClosing: true,
    });
    expect(options).not.toHaveProperty('multipart');
  });

  it('bounds multipart when enabled and disables it explicitly for services', () => {
    expect(buildFastifyOptions(config, { multipart: true })).toMatchObject({
      multipart: { limits: { fileSize: 25 * 1024 * 1024, files: 10 } },
    });
    expect(buildFastifyOptions(config, { multipart: { fileSize: 1024 } })).toMatchObject({
      multipart: { limits: { fileSize: 1024, files: 10 } },
    });
    expect(buildFastifyOptions(config, { multipart: false })).toMatchObject({ multipart: false });
  });
});
