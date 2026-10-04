/*
 * Cross-library smoke test: the infrastructure libs compose into one Fastify app with NO external
 * infrastructure. Everything is the real module / provider except `REDIS_CLIENT`, which is swapped
 * for `InMemoryRedis` (so the Redis-backed denylist, throttler storage and health check really run).
 *
 *   @app/config        AppConfigModule (+ forFeature namespaces pulled in by each lib)
 *   @app/observability ObservabilityModule — pino, nestjs-cls, /health, /metrics (Fastify hook)
 *   @app/redis         RedisModule (+ RedisHealthIndicator as readiness contributor), AppThrottlerModule
 *   @app/auth          AuthModule with global guards (JwtAuthGuard → RolesGuard → PermissionsGuard)
 *   @app/common        provideCommonEnhancersAsync (problem+json filter, pipes, timeout),
 *                      CorrelationIdMiddleware, MaintenanceModeMiddleware, @Public
 *   @app/bootstrap     buildFastifyOptions + configureHttpApp (the production wiring)
 *   @app/testing       createFastifyTestApp
 */

import {
  AccessTokenDenylist,
  AuthModule,
  type AuthUser,
  CurrentUser,
  Permission,
  RequirePermissions,
  Role,
  TokenService,
} from '@app/auth';
import {
  CorrelationIdMiddleware,
  EntityNotFoundException,
  generateId,
  HTTP_HEADERS,
  isUuidV7,
  MaintenanceModeMiddleware,
  PROBLEM_JSON_CONTENT_TYPE,
  type ProblemDetails,
  Public,
  provideCommonEnhancersAsync,
} from '@app/common';
import { type AppConfig, AppConfigModule, appConfig } from '@app/config';
import { ObservabilityModule, RequestContextService } from '@app/observability';
import {
  AppThrottlerModule,
  AuthThrottle,
  REDIS_CLIENT,
  RedisHealthIndicator,
  RedisModule,
} from '@app/redis';
import { InMemoryRedis } from '@app/redis/testing';
import { createFastifyTestApp } from '@app/testing';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  Param,
  Post,
  RequestMethod,
} from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildFastifyOptions, configureHttpApp } from './index.js';

// Read lazily by the config namespaces when the modules initialise (after these assignments).
process.env['LOG_LEVEL'] = 'silent';
process.env['THROTTLE_AUTH_LIMIT'] = '3';

/** Runtime maintenance switch handed to `MaintenanceModeMiddleware` through the common options. */
const maintenance = { on: false };

const echoSchema = z.object({ name: z.string().min(1).max(40) });

@Controller('smoke')
class SmokeController {
  constructor(private readonly context: RequestContextService) {}

  @Public()
  @Get('public')
  open(): { requestId: string | undefined } {
    return { requestId: this.context.requestId };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): { id: string; roles: Role[]; requestId: string | undefined } {
    return { id: user.id, roles: user.roles, requestId: this.context.requestId };
  }

  @Get('admin')
  @RequirePermissions(Permission.UsersManageRoles)
  admin(): { ok: true } {
    return { ok: true };
  }

  @Public()
  @Post('echo')
  @HttpCode(200)
  echo(@Body({ schema: echoSchema }) body: z.infer<typeof echoSchema>): { name: string } {
    return body;
  }

  @Public()
  @Get('widgets/:id')
  widget(@Param('id') id: string): never {
    throw new EntityNotFoundException('Widget', id);
  }

  @Public()
  @AuthThrottle()
  @Post('login')
  @HttpCode(200)
  login(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [
    AppConfigModule.forRoot(),
    ObservabilityModule.forRoot({ observe: false, healthContributors: [RedisHealthIndicator] }),
    RedisModule.forRootAsync(),
    // Before the throttler: global guards run in registration order (per-user tracking).
    AuthModule.forRootAsync({ globalGuards: true }),
    AppThrottlerModule.forRootAsync(),
  ],
  controllers: [SmokeController],
  providers: [
    ...provideCommonEnhancersAsync({
      inject: [appConfig.KEY],
      useFactory: (app: AppConfig) => ({
        exposeInternalErrors: !app.isProduction,
        maintenanceMode: () => maintenance.on,
      }),
    }),
  ],
})
class SmokeAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorrelationIdMiddleware, MaintenanceModeMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}

describe('infrastructure libs compose into one Fastify app (no infrastructure)', () => {
  const redis = new InMemoryRedis();
  let app: NestFastifyApplication;
  let tokens: TokenService;

  const bearer = async (roles: Role[] = [Role.User]) => {
    const issued = await tokens.issueAccessToken({
      id: generateId(),
      email: 'ada@example.com',
      roles,
    });
    return { ...issued, authorization: `Bearer ${issued.token}` };
  };

  const expectProblem = (
    response: { statusCode: number; headers: Record<string, unknown>; json: <T>() => T },
    status: number,
    code: string,
  ): ProblemDetails => {
    expect(response.statusCode).toBe(status);
    expect(response.headers['content-type']).toBe(PROBLEM_JSON_CONTENT_TYPE);
    const problem = response.json<ProblemDetails>();
    expect(problem).toMatchObject({ status, code });
    // The problem body, the response header and the log line share ONE request id.
    expect(problem.requestId).toBe(response.headers[HTTP_HEADERS.REQUEST_ID]);
    return problem;
  };

  beforeAll(async () => {
    const config = appConfig.parse();
    const builder = Test.createTestingModule({ imports: [SmokeAppModule] })
      .overrideProvider(REDIS_CLIENT)
      .useValue(redis.asRedis());
    app = await createFastifyTestApp(
      builder,
      (created) =>
        configureHttpApp(created, { config, shutdownHooks: false, processHandlers: false }),
      {
        adapter: new FastifyAdapter(buildFastifyOptions(config)),
        appOptions: { bufferLogs: true },
      },
    );
    tokens = app.get(TokenService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('ops endpoints (@Public, VERSION_NEUTRAL)', () => {
    it('GET /health/live → 200 without a token', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok' });
    });

    it('GET /health/ready → 200 with the Redis contributor resolved from RedisModule', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok', info: { redis: { status: 'up' } } });
    });

    it('GET /metrics → 200 with http_request_duration_seconds, incl. guard rejections', async () => {
      await app.inject({ method: 'GET', url: '/v1/smoke/me' }); // 401 (no token)
      const { authorization } = await bearer();
      await app.inject({ method: 'GET', url: '/v1/smoke/me', headers: { authorization } });

      const response = await app.inject({ method: 'GET', url: '/metrics' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('# TYPE http_request_duration_seconds histogram');
      expect(response.body).toMatch(
        /http_request_duration_seconds_count\{method="GET",route="\/v1\/smoke\/me",status_code="401"\} [1-9]/,
      );
      expect(response.body).toMatch(
        /http_request_duration_seconds_count\{method="GET",route="\/v1\/smoke\/me",status_code="200"\} [1-9]/,
      );
    });
  });

  describe('authentication (JwtAuthGuard global, @Public honoured)', () => {
    it('serves @Public routes without a token', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/smoke/public' });
      expect(response.statusCode).toBe(200);
    });

    it('rejects a protected route without a token: 401 problem+json MISSING_TOKEN', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/smoke/me' });
      const problem = expectProblem(response, 401, 'MISSING_TOKEN');
      expect(problem.instance).toBe('/v1/smoke/me');
    });

    it('rejects a forged token: 401 INVALID_TOKEN', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/smoke/me',
        headers: { authorization: 'Bearer not.a.jwt' },
      });
      expectProblem(response, 401, 'INVALID_TOKEN');
    });

    it('accepts a TokenService-issued access token: 200 with req.user', async () => {
      const { authorization, token } = await bearer([Role.User]);
      const claims = await tokens.verifyAccessToken(token);
      const response = await app.inject({
        method: 'GET',
        url: '/v1/smoke/me',
        headers: { authorization },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: claims.sub, roles: [Role.User] });
    });

    it('rejects a token denylisted in (fake) Redis: 401 TOKEN_REVOKED', async () => {
      const { authorization, jti, exp } = await bearer();
      await app.get(AccessTokenDenylist).deny(jti, exp);
      // Written through RedisModule's (overridden) client with the configured key prefix.
      expect(redis.getSync(`app:auth:denylist:${jti}`)).not.toBeNull();

      const response = await app.inject({
        method: 'GET',
        url: '/v1/smoke/me',
        headers: { authorization },
      });
      expectProblem(response, 401, 'TOKEN_REVOKED');
    });

    it('enforces RBAC after authentication: user → 403 FORBIDDEN, admin → 200', async () => {
      const user = await bearer([Role.User]);
      const denied = await app.inject({
        method: 'GET',
        url: '/v1/smoke/admin',
        headers: { authorization: user.authorization },
      });
      expectProblem(denied, 403, 'FORBIDDEN');

      const admin = await bearer([Role.Admin]);
      const allowed = await app.inject({
        method: 'GET',
        url: '/v1/smoke/admin',
        headers: { authorization: admin.authorization },
      });
      expect(allowed.statusCode).toBe(200);
    });
  });

  describe('request ids (Fastify genReqId = pino = nestjs-cls = x-request-id)', () => {
    it('echoes a safe incoming x-request-id and x-correlation-id', async () => {
      const { authorization } = await bearer();
      const response = await app.inject({
        method: 'GET',
        url: '/v1/smoke/me',
        headers: {
          authorization,
          [HTTP_HEADERS.REQUEST_ID]: 'smoke-req.1',
          [HTTP_HEADERS.CORRELATION_ID]: 'smoke-chain.1',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers[HTTP_HEADERS.REQUEST_ID]).toBe('smoke-req.1');
      expect(response.headers[HTTP_HEADERS.CORRELATION_ID]).toBe('smoke-chain.1');
      expect(response.json()).toMatchObject({ requestId: 'smoke-req.1' });
    });

    it('replaces an unsafe incoming id with a UUIDv7 (same one in cls and the header)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/smoke/public',
        headers: { [HTTP_HEADERS.REQUEST_ID]: 'bad id\r\n<script>' },
      });
      const { requestId } = response.json<{ requestId: string }>();
      expect(isUuidV7(requestId)).toBe(true);
      expect(response.headers[HTTP_HEADERS.REQUEST_ID]).toBe(requestId);
      expect(response.headers[HTTP_HEADERS.CORRELATION_ID]).toBe(requestId);
    });

    it('carries the adopted id into problem responses', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/smoke/me',
        headers: { [HTTP_HEADERS.REQUEST_ID]: 'smoke-req.401' },
      });
      expect(expectProblem(response, 401, 'MISSING_TOKEN').requestId).toBe('smoke-req.401');
    });
  });

  describe('errors & validation (AllExceptionsFilter, Standard Schema pipe)', () => {
    it('maps a DomainException to problem+json', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/smoke/widgets/w-1' });
      const problem = expectProblem(response, 404, 'NOT_FOUND');
      expect(problem.type).toMatch(/^https:\/\/.+\/not-found$/);
    });

    it('validates a zod body natively: 400 with structured issues', async () => {
      const ok = await app.inject({
        method: 'POST',
        url: '/v1/smoke/echo',
        payload: { name: 'Ada' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ name: 'Ada' });

      const bad = await app.inject({
        method: 'POST',
        url: '/v1/smoke/echo',
        payload: { name: '' },
      });
      const problem = expectProblem(bad, 400, 'VALIDATION_FAILED');
      expect(problem.errors).toEqual([expect.objectContaining({ path: 'name' })]);
    });

    it('renders unknown routes as 404 problem+json', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/nope' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toBe(PROBLEM_JSON_CONTENT_TYPE);
    });
  });

  describe('rate limiting (AppThrottlerGuard + RedisThrottlerStorage on the fake)', () => {
    it('applies the @AuthThrottle window: 429 problem+json with Retry-After', async () => {
      const hit = () => app.inject({ method: 'POST', url: '/v1/smoke/login' });
      for (let i = 0; i < 3; i += 1) expect((await hit()).statusCode).toBe(200);

      const limited = await hit();
      expectProblem(limited, 429, 'RATE_LIMITED');
      expect(Number(limited.headers[HTTP_HEADERS.RETRY_AFTER])).toBeGreaterThan(0);
    });
  });

  describe('maintenance mode (runtime switch via provideCommonEnhancersAsync)', () => {
    it('answers 503 + Retry-After while on, but keeps probes and metrics up', async () => {
      maintenance.on = true;
      try {
        const blocked = await app.inject({ method: 'GET', url: '/v1/smoke/public' });
        expectProblem(blocked, 503, 'SERVICE_UNAVAILABLE');
        expect(blocked.headers[HTTP_HEADERS.RETRY_AFTER]).toBe('120');
        expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
      } finally {
        maintenance.on = false;
      }
      expect((await app.inject({ method: 'GET', url: '/v1/smoke/public' })).statusCode).toBe(200);
    });
  });
});
