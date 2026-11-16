import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { getContextType } from '@platform/common';
import { isObjectLike } from 'lodash-es';
import { catchError, type Observable, tap, throwError } from 'rxjs';
import { isGrpcMetadata } from './grpc-metadata.js';
import { parseGrpcOperation, recordGrpcCall } from './grpc-metrics.js';
import { exceptionToGrpcError, grpcStatusName } from './grpc-status.mapping.js';

/**
 * Server-side gRPC call metrics (applied by `@GrpcController()`, inside `GrpcContextInterceptor`).
 * The method comes from grpc-js `call.getPath()`; a failure is labelled with the status the
 * controller's `DomainToGrpcExceptionFilter` will send (`exceptionToGrpcError`). No-op outside gRPC.
 */
@Injectable()
export class GrpcMetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (
      getContextType(context) !== 'rpc' ||
      !isGrpcMetadata(context.switchToRpc().getContext<unknown>())
    ) {
      return next.handle();
    }
    const call: unknown = context.getArgByIndex(2);
    const path =
      isObjectLike(call) && typeof (call as { getPath?: unknown }).getPath === 'function'
        ? (call as { getPath(): string }).getPath()
        : `${context.getClass().name}/${context.getHandler().name}`;
    const target = parseGrpcOperation(path);
    const startedAt = performance.now();
    const seconds = (): number => (performance.now() - startedAt) / 1_000;
    return next.handle().pipe(
      tap({ complete: () => recordGrpcCall('server', target, 'OK', seconds()) }),
      catchError((error: unknown) => {
        recordGrpcCall(
          'server',
          target,
          grpcStatusName(exceptionToGrpcError(error).code),
          seconds(),
        );
        return throwError(() => error);
      }),
    );
  }
}
