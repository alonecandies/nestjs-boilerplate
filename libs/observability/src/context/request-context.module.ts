import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ClsModule, type ClsService } from 'nestjs-cls';
import {
  incomingCorrelationId,
  type RequestIdCarrier,
  requestIdOf,
} from '../logging/request-id.js';
import { CLS_CORRELATION_ID } from '../observability.constants.js';
import { RequestContextInterceptor } from './request-context.interceptor.js';
import { RequestContextService } from './request-context.service.js';

/** What `ClsMiddleware` hands to `idGenerator`/`setup` on Fastify: the raw request (middie). */
type ClsRawRequest = RequestIdCarrier & { id?: unknown };

/**
 * nestjs-cls wiring (internal to `ObservabilityModule`). `ClsModule.forRoot` lives HERE and only
 * here; other packages extend it with `ClsModule.registerPlugins(...)` (e.g. the transactional
 * plugin of `@app/database`).
 *
 * The context id IS the request id: `idGenerator` reuses Fastify's `request.id` (copied onto the
 * raw request by middie, produced by `resolveRequestId`), so `cls.getId()`, the log field
 * `requestId` and the `x-request-id` response header agree.
 */
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: ClsRawRequest) => requestIdOf(req),
        setup: (cls: ClsService, req: ClsRawRequest) => {
          const correlationId = incomingCorrelationId(req);
          if (correlationId !== undefined) cls.set(CLS_CORRELATION_ID, correlationId);
        },
      },
    }),
  ],
  providers: [
    RequestContextService,
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
  ],
  exports: [RequestContextService],
})
export class RequestContextModule {}
