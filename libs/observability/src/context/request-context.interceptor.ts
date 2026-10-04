import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { CLS_ID, ClsService } from 'nestjs-cls';
import { Observable } from 'rxjs';
import { resolveContextRequestId } from '../logging/request-id.js';

/**
 * Opens a request context for handlers that no HTTP middleware ran for: gRPC calls and Kafka
 * messages (hybrid apps run global interceptors for them via `inheritAppConfig: true`), socket.io
 * messages and graphql-ws subscriptions. HTTP requests (REST and GraphQL over HTTP) already have
 * the context the `ClsMiddleware` opened, so they pass straight through — nestjs-cls' own
 * `ClsInterceptor` can't be used for this because it always starts a new, empty store, which
 * would discard the middleware's request id.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  constructor(private readonly cls: ClsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.cls.isActive()) return next.handle();
    // Subscribe INSIDE the context: the handler only runs on subscription, and AsyncLocalStorage
    // propagates to everything it awaits from there.
    return new Observable<unknown>((subscriber) =>
      this.cls.run(() => {
        this.cls.set(CLS_ID, resolveContextRequestId(context));
        return next.handle().subscribe(subscriber);
      }),
    );
  }
}
