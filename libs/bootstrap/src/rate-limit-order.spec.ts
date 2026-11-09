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
