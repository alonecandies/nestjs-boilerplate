import { Controller, Get, Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthModule } from '@platform/auth';
import { Public, provideCommonEnhancersAsync } from '@platform/common';
import { type AppConfig, AppConfigModule, appConfig } from '@platform/config';
import { ObservabilityModule } from '@platform/observability';
import { AppThrottlerModule, IpThrottlerModule, REDIS_CLIENT, RedisModule } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import { createFastifyTestApp } from '@platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFastifyOptions, configureHttpApp } from './index.js';

process.env['LOG_LEVEL'] = 'silent';
process.env['THROTTLE_IP_LIMIT'] = '3';

@Controller('order')
class OrderController {
  @Get('private')
  privateRoute(): { ok: true } {
    return { ok: true };
  }

  @Public()
  @Get('public')
  publicRoute(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [
    AppConfigModule.forRoot(),
    ObservabilityModule.forRoot({ observe: false }),
    RedisModule.forRootAsync(),
    IpThrottlerModule, // BEFORE AuthModule: counts requests JwtAuthGuard rejects
    AuthModule.forRootAsync({ globalGuards: true }),
    AppThrottlerModule.forRootAsync(),
  ],
  controllers: [OrderController],
  providers: [
    // The problem+json exception filter: maps 401 and 429 to their `code`.
    ...provideCommonEnhancersAsync({
      inject: [appConfig.KEY],
      useFactory: (app: AppConfig) => ({ exposeInternalErrors: !app.isProduction }),
    }),
  ],
})
class OrderAppModule {}

describe('guard order: the ip throttler runs before authentication', () => {
  const redis = new InMemoryRedis();
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const config = appConfig.parse();
    const builder = Test.createTestingModule({ imports: [OrderAppModule] })
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
  });

  afterAll(async () => {
    await app.close();
  });

  it('sends the IETF headers and exposes them (and Retry-After) through CORS', async () => {
    await redis.flushall();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/order/public',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['ratelimit-policy']).toBe('"ip";q=3;w=60, "user";q=300;w=60');
    expect(response.headers['ratelimit']).toBe('"ip";r=2;t=60, "user";r=299;t=60');
    const exposed = String(response.headers['access-control-expose-headers']).toLowerCase();
    for (const name of ['ratelimit-policy', 'ratelimit', 'retry-after'])
      expect(exposed).toContain(name);
    expect(response.headers['x-ratelimit-limit']).toBeUndefined();
    await redis.flushall();
  });

  it('counts 401s: the 4th unauthenticated request from one IP is 429, not 401', async () => {
    const hit = () =>
      app.inject({
        method: 'GET',
        url: '/v1/order/private',
        headers: { authorization: 'Bearer nope' },
      });
    for (let i = 0; i < 3; i += 1) expect((await hit()).statusCode).toBe(401);
    const limited = await hit();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    // Same IP, public route: the ip budget is global across routes.
    expect((await app.inject({ method: 'GET', url: '/v1/order/public' })).statusCode).toBe(429);
    // Ops paths stay exempt.
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });
});
