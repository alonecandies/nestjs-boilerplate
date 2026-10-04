import { generateId, getContextType } from '@app/common';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  Optional,
} from '@nestjs/common';
import { CLS_ID, ClsService } from 'nestjs-cls';
import { Observable } from 'rxjs';
import { RPC_CLS_KEYS } from '../context/transport-context.js';
import { type IncomingRpcContext, isGrpcMetadata, readIncomingMetadata } from './grpc-metadata.js';

/**
 * Opens a nestjs-cls context for each gRPC call and fills it from the incoming metadata:
 * - `CLS_ID` (`cls.getId()`) = the caller's `x-request-id`, or a new uuidv7. Logs from the gateway
 *   and the service then share one id.
 * - `RPC_CLS_KEYS.CORRELATION_ID` = the caller's `x-correlation-id`, else the request id.
 * - `RPC_CLS_KEYS.USER_ID` / `RPC_CLS_KEYS.CALLER`, the asserted caller.
 *
 * nestjs-cls middleware only runs for HTTP, which is why gRPC needs this. The handler is
 * subscribed inside `cls.run()`, so the context follows every await in the handler. This is the
 * same technique as nestjs-cls' own `ClsInterceptor`. Other transports pass straight through.
 * Without `ClsModule` in the app the interceptor does nothing.
 */
@Injectable()
export class GrpcContextInterceptor implements NestInterceptor {
  constructor(@Optional() private readonly cls?: ClsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const cls = this.cls;
    if (cls === undefined || getContextType(context) !== 'rpc') return next.handle();
    const metadata = context.switchToRpc().getContext<unknown>();
    if (!isGrpcMetadata(metadata)) return next.handle();

    const caller: IncomingRpcContext = readIncomingMetadata(metadata);
    const requestId = caller.requestId ?? generateId();
    return new Observable<unknown>((subscriber) =>
      // 'inherit': if a global ClsGuard/ClsInterceptor already opened a context, extend a copy of
      // it. The id from the caller still wins over the one that initializer generated.
      cls.run({ ifNested: 'inherit' }, () => {
        cls.set(CLS_ID, requestId);
        cls.set(RPC_CLS_KEYS.CORRELATION_ID, caller.correlationId ?? requestId);
        cls.set(RPC_CLS_KEYS.CALLER, caller);
        if (caller.userId !== undefined) cls.set(RPC_CLS_KEYS.USER_ID, caller.userId);
        return next.handle().subscribe(subscriber);
      }),
    );
  }
}
