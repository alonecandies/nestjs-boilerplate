import { HTTP_HEADERS, isUuidV7 } from '@app/common';
import { type CallHandler, type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { ClsModule } from 'nestjs-cls';
import { defer, lastValueFrom, of } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestContextInterceptor } from './request-context.interceptor.js';
import { RequestContextService } from './request-context.service.js';

@Module({
  imports: [ClsModule.forRoot({ global: true })],
  providers: [RequestContextService, RequestContextInterceptor],
})
class TestModule {}

describe('request context', () => {
  let app: INestApplicationContext;
  let context: RequestContextService;
  let interceptor: RequestContextInterceptor;

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(TestModule, { logger: false });
    context = app.get(RequestContextService);
    interceptor = app.get(RequestContextInterceptor);
  });

  afterAll(async () => {
    await app.close();
  });

  /** A handler that reports the context it ran in. */
  const probe: CallHandler = {
    handle: () =>
      defer(() => of({ requestId: context.requestId, correlationId: context.correlationId })),
  };

  describe('RequestContextService', () => {
    it('is inert outside a context', () => {
      expect(context.isActive).toBe(false);
      expect(context.requestId).toBeUndefined();
      expect(context.correlationId).toBeUndefined();
      context.userId = 'ignored';
      expect(context.userId).toBeUndefined();
    });

    it('run() opens a fresh context with the given ids', () => {
      const seen = context.run(
        () => {
          context.userId = 'user-2';
          return {
            requestId: context.requestId,
            correlationId: context.correlationId,
            userId: context.userId,
          };
        },
        { requestId: 'job-1', correlationId: 'chain-1', userId: 'user-1' },
      );
      expect(seen).toEqual({ requestId: 'job-1', correlationId: 'chain-1', userId: 'user-2' });
      expect(context.isActive).toBe(false);
    });

    it('run() mints a UUIDv7 for missing/unsafe ids; correlation defaults to the request id', () => {
      const seen = context.run(() => ({ id: context.requestId, corr: context.correlationId }), {
        requestId: 'not safe!',
      });
      expect(isUuidV7(seen.id)).toBe(true);
      expect(seen.corr).toBe(seen.id);
    });
  });

  describe('RequestContextInterceptor', () => {
    it('opens a context for an RPC handler, keyed by the caller request id', async () => {
      const metadata = { get: (key: string) => (key === HTTP_HEADERS.REQUEST_ID ? ['rpc-7'] : []) };
      const ctx = new ExecutionContextHost([{}, metadata]);
      ctx.setType('rpc');

      const seen = await lastValueFrom(interceptor.intercept(ctx, probe));

      expect(seen).toEqual({ requestId: 'rpc-7', correlationId: 'rpc-7' });
      expect(context.isActive).toBe(false);
    });

    it('keeps an already-open context (HTTP: opened by ClsMiddleware)', async () => {
      const ctx = new ExecutionContextHost([{ headers: {} }, {}]);
      const seen = await context.run(() => lastValueFrom(interceptor.intercept(ctx, probe)), {
        requestId: 'http-1',
      });
      expect(seen).toMatchObject({ requestId: 'http-1' });
    });
  });
});
