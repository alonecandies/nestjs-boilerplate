import type { ApolloDriverConfig } from '@nestjs/apollo';
import { Global, type INestApplicationContext, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { GRAPHQL_MODULE_OPTIONS, Query, Resolver } from '@nestjs/graphql';
import { AccessTokenDenylist, AuthModule, RevocationSweeper, Role } from '@platform/auth';
import { signTestAccessToken } from '@platform/auth/testing';
import { AppConfigModule, redisConfig } from '@platform/config';
import { REDIS_CLIENT, RedisKeyService } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRAPHQL_WS_REVOCATION_SWEEPER } from './auth/graphql-ws-revocation.module.js';
import { WS_CLOSE_TOKEN_REVOKED } from './auth/subscription-auth.js';
import { AppGraphqlModule } from './graphql.module.js';

const SWEEP_INTERVAL_MS = 4_321;

@Resolver()
class PingResolver {
  @Query(() => String)
  ping(): string {
    return 'pong';
  }
}

/** Stands in for the global RedisModule (the access-token denylist): no connection. */
@Global()
@Module({
  imports: [ConfigModule.forFeature(redisConfig)],
  providers: [{ provide: REDIS_CLIENT, useValue: new InMemoryRedis().asRedis() }, RedisKeyService],
  exports: [REDIS_CLIENT, RedisKeyService],
})
class FakeRedisModule {}

@Module({
  imports: [
    AppConfigModule.forRoot(),
    FakeRedisModule,
    AuthModule.forRootAsync({ globalGuards: false }),
    AppGraphqlModule.forRootAsync(),
  ],
  providers: [PingResolver],
})
class TestAppModule {}

type WsHandlers = {
  onConnect(ctx: unknown): Promise<boolean> | boolean;
  onClose(ctx: unknown): void;
};

/** The graphql-ws handlers the Apollo driver was configured with. */
function graphqlWsHandlers(app: INestApplicationContext): WsHandlers {
  const options = app.get<ApolloDriverConfig>(GRAPHQL_MODULE_OPTIONS, { strict: false });
  const subscriptions = options.subscriptions as Record<string, WsHandlers> | undefined;
  const handlers = subscriptions?.['graphql-ws'];
  if (handlers === undefined) throw new Error('graphql-ws is not configured');
  return handlers;
}

describe('AppGraphqlModule — graphql-ws revocation sweeper', () => {
  let app: INestApplicationContext | undefined;

  beforeEach(() => {
    vi.stubEnv('WS_REVOCATION_SWEEP_INTERVAL_MS', String(SWEEP_INTERVAL_MS));
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
  });

  it('starts one sweeper at the configured interval and leaves no sweeper timer after close', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const context = await NestFactory.createApplicationContext(TestAppModule, {
      logger: false,
      abortOnError: false,
    });
    app = context;

    expect(context.get(GRAPHQL_WS_REVOCATION_SWEEPER, { strict: false })).toBeInstanceOf(
      RevocationSweeper,
    );
    const sweepTimers = setIntervalSpy.mock.calls.flatMap((call, index) =>
      call[1] === SWEEP_INTERVAL_MS ? [setIntervalSpy.mock.results[index]?.value as unknown] : [],
    );
    expect(sweepTimers).toHaveLength(1);
    expect(clearIntervalSpy).not.toHaveBeenCalledWith(sweepTimers[0]);

    await context.close();
    app = undefined;

    expect(clearIntervalSpy).toHaveBeenCalledWith(sweepTimers[0]);
  });

  it('hands that sweeper to the graphql-ws handlers: a revoked connection closes on its sweep', async () => {
    const context = await NestFactory.createApplicationContext(TestAppModule, {
      logger: false,
      abortOnError: false,
    });
    app = context;
    const sweeper = context.get<RevocationSweeper>(GRAPHQL_WS_REVOCATION_SWEEPER, {
      strict: false,
    });
    const handlers = graphqlWsHandlers(context);
    const issued = await signTestAccessToken({
      id: '0199a3c1-7b2e-7cc0-8f1e-2f7c3b4d5e6f',
      email: 'jane@example.com',
      roles: [Role.User],
    });
    const close = vi.fn();
    const ctx = {
      connectionParams: { authorization: `Bearer ${issued.token}` },
      extra: { socket: { close } },
    };

    await expect(handlers.onConnect(ctx)).resolves.toBe(true);
    expect(sweeper.size).toBe(1);

    await context.get(AccessTokenDenylist, { strict: false }).deny(issued.jti, issued.exp);
    await expect(sweeper.sweep()).resolves.toBe(1);
    expect(close).toHaveBeenCalledWith(WS_CLOSE_TOKEN_REVOKED, 'Access token revoked');

    handlers.onClose(ctx);
    expect(sweeper.size).toBe(0);
  });
});
