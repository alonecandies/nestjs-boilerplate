import type { DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { AppConfigModule } from './app-config.module.js';
import { appConfig } from './namespaces/app.config.js';
import { observabilityConfig } from './namespaces/observability.config.js';
import { redisConfig } from './namespaces/redis.config.js';

type Provided = { provide: unknown; useFactory?: (...args: unknown[]) => unknown };

describe('AppConfigModule.forRoot', () => {
  it('is global and wraps a global, cached ConfigModule that ignores .env files', async () => {
    const module = AppConfigModule.forRoot();
    expect(module).toMatchObject({ module: AppConfigModule, global: true });

    const inner = await (module.imports?.[0] as Promise<DynamicModule>);
    expect(inner.module).toBe(ConfigModule);
    expect(inner.global).toBe(true);
    expect(inner.exports).toEqual(expect.arrayContaining([appConfig.KEY, observabilityConfig.KEY]));
    expect(inner.exports).not.toContain(redisConfig.KEY);
  });

  it('registers namespace providers whose factories return the parsed config', async () => {
    const inner = await (AppConfigModule.forRoot({ load: [redisConfig] })
      .imports?.[0] as Promise<DynamicModule>);
    const providers = (inner.providers ?? []) as Provided[];
    const redis = providers.find((p) => p.provide === redisConfig.KEY);
    expect(redis?.useFactory?.()).toMatchObject({
      url: expect.stringMatching(/^rediss?:\/\//) as string,
    });
    expect(inner.exports).toContain(redisConfig.KEY);
  });
});
