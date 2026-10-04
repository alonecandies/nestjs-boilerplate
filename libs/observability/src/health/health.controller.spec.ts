import { type INestApplicationContext, Injectable, Module, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import type { FastifyReply } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';
import { HealthModule } from './health.module.js';
import { HealthContributor } from './health-contributor.js';
import { HealthContributorRegistry } from './health-contributor.registry.js';

/** Provided by the test module (like infra libs do) → the registry must reuse THIS instance. */
@Injectable()
class DatabaseContributor extends HealthContributor {
  override readonly key = 'postgres';
  calls = 0;

  constructor(private readonly health: HealthIndicatorService) {
    super();
  }

  override check(): Promise<HealthIndicatorResult> {
    this.calls++;
    return Promise.resolve(this.health.check(this.key).up({ latencyMs: 1 }));
  }
}

/** Not provided anywhere → instantiated on demand. Throws like a real driver would. */
@Injectable()
class RedisContributor extends HealthContributor {
  override readonly key = 'redis';

  override check(): Promise<HealthIndicatorResult> {
    return Promise.reject(new Error('connect ECONNREFUSED 10.0.0.7:6379'));
  }
}

/** Never settles: must be cut off by the readiness timeout. */
@Injectable()
class HangingContributor extends HealthContributor {
  override readonly key = 'kafka';

  override check(): Promise<HealthIndicatorResult> {
    return new Promise(() => undefined);
  }
}

@Injectable()
class DuplicateKeyContributor extends HealthContributor {
  override readonly key = 'postgres';

  override check(): Promise<HealthIndicatorResult> {
    return Promise.resolve({ postgres: { status: 'up' } });
  }
}

const fakeReply = () => {
  const reply = { status: vi.fn() };
  reply.status.mockReturnValue(reply);
  return reply;
};

describe('HealthController', () => {
  let app: INestApplicationContext | undefined;

  async function boot(
    contributors: Type<HealthContributor>[],
    exposeDetails: boolean,
  ): Promise<INestApplicationContext> {
    @Module({
      imports: [
        HealthModule.register({
          contributors,
          readinessTimeoutMs: 50,
          shutdownDrainMs: 0,
          exposeDetails,
        }),
      ],
      providers: [DatabaseContributor],
    })
    class TestModule {}
    app = await NestFactory.createApplicationContext(TestModule, {
      logger: false,
      abortOnError: false,
    });
    return app;
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('liveness answers ok without touching any dependency', async () => {
    const ctx = await boot([DatabaseContributor], true);
    expect(ctx.get(HealthController).live()).toEqual({
      status: 'ok',
      info: {},
      error: {},
      details: {},
    });
    expect(ctx.get(DatabaseContributor).calls).toBe(0);
  });

  it('readiness is ok (200) when every contributor is up, reusing provided instances', async () => {
    const ctx = await boot([DatabaseContributor], true);
    const reply = fakeReply();

    const result = await ctx.get(HealthController).ready(reply as unknown as FastifyReply);

    expect(result.status).toBe('ok');
    expect(result.details).toEqual({ postgres: { status: 'up', latencyMs: 1 } });
    expect(reply.status).not.toHaveBeenCalled();
    expect(ctx.get(DatabaseContributor).calls).toBe(1);
  });

  it('turns throws and timeouts into `down` entries and answers 503', async () => {
    const ctx = await boot([DatabaseContributor, RedisContributor, HangingContributor], true);
    const reply = fakeReply();

    const result = await ctx.get(HealthController).ready(reply as unknown as FastifyReply);

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(result.status).toBe('error');
    expect(result.details).toEqual({
      postgres: { status: 'up', latencyMs: 1 },
      redis: { status: 'down', message: 'connect ECONNREFUSED 10.0.0.7:6379' },
      kafka: { status: 'down', message: 'timed out after 50 ms' },
    });
  });

  it('hides failure details when exposeDetails is off (production)', async () => {
    const ctx = await boot([DatabaseContributor, RedisContributor], false);

    const result = await ctx.get(HealthController).ready(fakeReply() as unknown as FastifyReply);

    expect(result.details).toEqual({
      postgres: { status: 'up', latencyMs: 1 },
      redis: { status: 'down' },
    });
    expect(result.error).toEqual({ redis: { status: 'down' } });
  });

  it('is ready with no contributors', async () => {
    const ctx = await boot([], true);
    expect(ctx.get(HealthContributorRegistry).contributors).toEqual([]);
    const result = await ctx.get(HealthController).ready(fakeReply() as unknown as FastifyReply);
    expect(result).toMatchObject({ status: 'ok', details: {} });
  });

  it('rejects duplicate contributor keys at boot', async () => {
    await expect(boot([DatabaseContributor, DuplicateKeyContributor], true)).rejects.toThrow(
      'Duplicate health contributor key(s): postgres',
    );
  });
});
