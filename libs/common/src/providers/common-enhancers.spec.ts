import { type INestApplicationContext, Module, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEOUT_MS,
  EXCEPTIONS_FILTER_OPTIONS,
  MAINTENANCE_MODE,
  MAINTENANCE_MODE_OPTIONS,
} from '../constants/tokens.constants.js';
import { AllExceptionsFilter } from '../filters/all-exceptions.filter.js';
import { TimeoutInterceptor } from '../interceptors/timeout.interceptor.js';
import { MaintenanceModeMiddleware } from '../middlewares/maintenance-mode.middleware.js';
import { provideCommonEnhancers, provideCommonEnhancersAsync } from './common-enhancers.js';

const APP_CONFIG = Symbol('APP_CONFIG');

async function boot(providers: Provider[]): Promise<INestApplicationContext> {
  @Module({ providers: [...providers, MaintenanceModeMiddleware] })
  class TestModule {}
  return NestFactory.createApplicationContext(TestModule, { logger: false, abortOnError: false });
}

describe('provideCommonEnhancers', () => {
  let app: INestApplicationContext | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('registers two global pipes, the filter and the interceptor', () => {
    const providers = provideCommonEnhancers();
    const tokens = providers.map((p) => (typeof p === 'function' ? p : p.provide));
    expect(tokens.filter((t) => t === APP_PIPE)).toHaveLength(2);
    expect(providers).toContainEqual({ provide: APP_FILTER, useClass: AllExceptionsFilter });
    expect(providers).toContainEqual({ provide: APP_INTERCEPTOR, useClass: TimeoutInterceptor });
  });

  it('provides safe defaults for every option token', async () => {
    app = await boot(provideCommonEnhancers());
    expect(app.get(EXCEPTIONS_FILTER_OPTIONS)).toEqual({ exposeInternal: false });
    expect(app.get(DEFAULT_TIMEOUT_MS)).toBe(30_000);
    expect(app.get(MAINTENANCE_MODE)).toBe(false);
    expect(app.get(MAINTENANCE_MODE_OPTIONS)).toEqual({});
  });

  it('resolves options from DI in the async variant and wires the middleware', async () => {
    app = await boot([
      {
        provide: APP_CONFIG,
        useValue: { isProduction: false, requestTimeoutMs: 5_000, maintenance: true },
      },
      ...provideCommonEnhancersAsync({
        inject: [APP_CONFIG],
        useFactory: (cfg: {
          isProduction: boolean;
          requestTimeoutMs: number;
          maintenance: boolean;
        }) => ({
          exposeInternalErrors: !cfg.isProduction,
          defaultTimeoutMs: cfg.requestTimeoutMs,
          maintenanceMode: cfg.maintenance,
          maintenanceModeOptions: { retryAfterSec: 60 },
        }),
      }),
    ]);
    expect(app.get(EXCEPTIONS_FILTER_OPTIONS)).toEqual({ exposeInternal: true });
    expect(app.get(DEFAULT_TIMEOUT_MS)).toBe(5_000);
    expect(app.get(MaintenanceModeMiddleware)).toMatchObject({
      maintenanceMode: true,
      options: { retryAfterSec: 60, bypassPaths: ['/health*', '/metrics'] },
    });
  });
});
