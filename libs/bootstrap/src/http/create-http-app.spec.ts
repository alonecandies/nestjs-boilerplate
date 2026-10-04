import { CorrelationIdMiddleware, HTTP_HEADERS, isUuidV7 } from '@app/common';
import { AppConfigModule, appConfig, observabilityConfig } from '@app/config';
import { HealthContributor, ObservabilityModule, RequestContextService } from '@app/observability';
import {
  Controller,
  Get,
  Injectable,
  Logger,
  type LoggerService,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('GET /metrics with METRICS_BEARER_TOKEN', () => {
  const TOKEN = 'scrape-token-0123456789abcdef';

  it('answers 404 without the right bearer token and 200 with it', async () => {
    process.env['METRICS_BEARER_TOKEN'] = TOKEN;
    const app = await createHttpApp(SmokeModule, { processHandlers: false, shutdownHooks: false });
    try {
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      const scrape = (authorization?: string) =>
        app.inject({
          method: 'GET',
          url: '/metrics',
          ...(authorization === undefined ? {} : { headers: { authorization } }),
        });
      expect((await scrape()).statusCode).toBe(404);
      expect((await scrape('Bearer wrong-token-0123456789abcdef')).statusCode).toBe(404);
      expect((await scrape(TOKEN)).statusCode).toBe(404);
      const ok = await scrape(`Bearer ${TOKEN}`);
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toContain('process_resident_memory_bytes');
    } finally {
      delete process.env['METRICS_BEARER_TOKEN'];
      await app.close();
    }
  });
});

const UNREACHABLE = 'UNREACHABLE_DEPENDENCY';

@Module({
  imports: [AppConfigModule.forRoot(), ObservabilityModule.forRoot({ observe: false })],
  providers: [
    {
      provide: UNREACHABLE,
      useFactory: () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      },
    },
  ],
})
class UnreachableDependencyModule {}

describe('createHttpApp boot failure (inside NestFactory.create, before pino is attached)', () => {
  // The create phase installs a process-global static logger: restore the previous one afterwards.
  const staticLogger = Logger as unknown as { staticInstanceRef?: LoggerService };
  let previous: LoggerService | undefined;

  beforeEach(() => {
    previous = staticLogger.staticInstanceRef;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Logger.overrideLogger(previous ?? false);
  });

  it('prints the error as ONE line of JSON when logs are JSON (production)', async () => {
    const env = { NODE_ENV: 'production', SERVICE_NAME: 'orders', LOG_LEVEL: 'info' };
    const written: string[] = [];
    const capture = (chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);

    await expect(
      createHttpApp(UnreachableDependencyModule, {
        config: appConfig.parse(env),
        observability: observabilityConfig.parse(env),
        processHandlers: false,
        shutdownHooks: false,
      }),
    ).rejects.toThrow('ECONNREFUSED');
    vi.restoreAllMocks();

    const lines = written
      .join('')
      .split('\n')
      .filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    // Every line (buffered bootstrap logs included) is parseable JSON — no ANSI colours.
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const failure = records.find((record) => record['context'] === 'ExceptionHandler');
    expect(failure).toMatchObject({
      level: 'error',
      service: 'orders',
      message: 'connect ECONNREFUSED 127.0.0.1:6379',
      error: { name: 'Error', stack: expect.stringContaining('ECONNREFUSED') },
    });
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
      trustProxy: false,
      requestIdHeader: false,
      forceCloseConnections: 'idle',
      return503OnClosing: true,
    });
    expect(options).not.toHaveProperty('multipart');
  });

  describe('client address (req.ip feeds the per-IP throttle and session ip)', () => {
    const LB = '10.0.0.5';
    const CLIENT = '203.0.113.7';

    async function ipSeenBy(env: Record<string, string>, remoteAddress: string, xff: string) {
      const server = Fastify(buildFastifyOptions(appConfig.parse(env)));
      server.get('/ip', (request) => ({ ip: request.ip }));
      try {
        const response = await server.inject({
          method: 'GET',
          url: '/ip',
          remoteAddress,
          headers: { 'x-forwarded-for': xff },
        });
        return response.json<{ ip: string }>().ip;
      } finally {
        await server.close();
      }
    }

    it('ignores a client-supplied X-Forwarded-For by default', async () => {
      expect(await ipSeenBy({}, CLIENT, '6.6.6.1')).toBe(CLIENT);
      expect(await ipSeenBy({ NODE_ENV: 'production' }, CLIENT, '6.6.6.2')).toBe(CLIENT);
    });

    it('a proxy CIDR list takes what the load balancer appended, never a spoofed entry', async () => {
      const env = { NODE_ENV: 'production', TRUST_PROXY: '10.0.0.0/8' };
      // The client sent "6.6.6.1"; the LB (trusted) appended the real peer address.
      expect(await ipSeenBy(env, LB, `6.6.6.1, ${CLIENT}`)).toBe(CLIENT);
      // A direct (untrusted) peer can't pick its address either.
      expect(await ipSeenBy(env, CLIENT, '6.6.6.1')).toBe(CLIENT);
    });
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
