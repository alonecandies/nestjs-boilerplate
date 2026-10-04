import { EXCEPTIONS_FILTER_OPTIONS, type ExceptionsFilterOptions } from '@app/common';
import {
  type ArgumentsHost,
  Catch,
  Inject,
  Logger,
  Optional,
  type RpcExceptionFilter,
} from '@nestjs/common';
import { type Observable, throwError } from 'rxjs';
import {
  exceptionToGrpcError,
  type GrpcErrorResponse,
  grpcStatusName,
  isServerSideGrpcStatus,
} from './grpc-status.mapping.js';

interface ServerCallLike {
  getPath?: () => string;
}

/**
 * Controller-scoped catch-all filter for gRPC handlers (applied by `@GrpcController()`). It maps
 * `DomainException`, `HttpException`, zod and unknown errors to proper gRPC statuses and
 * trailers (see `exceptionToGrpcError`). Without a gRPC filter every error reaches the client as
 * `UNKNOWN "Internal server error"`.
 *
 * It must be controller-scoped. A global RPC filter combined with `inheritAppConfig: true` also
 * catches HTTP errors, and those requests then hang (nest-distributed §7.3). Because it runs
 * before the global `AllExceptionsFilter`, it does its own logging: server-side statuses at
 * `error` with the stack, client mistakes at `debug`.
 */
@Catch()
export class DomainToGrpcExceptionFilter implements RpcExceptionFilter<unknown> {
  private readonly logger = new Logger(DomainToGrpcExceptionFilter.name);
  private readonly exposeInternal: boolean;

  constructor(@Optional() @Inject(EXCEPTIONS_FILTER_OPTIONS) options?: ExceptionsFilterOptions) {
    this.exposeInternal = options?.exposeInternal ?? false;
  }

  catch(exception: unknown, host: ArgumentsHost): Observable<GrpcErrorResponse> {
    const error = exceptionToGrpcError(exception, { exposeInternal: this.exposeInternal });
    const path = host.getArgByIndex<ServerCallLike | undefined>(2)?.getPath?.() ?? 'grpc';
    const summary = `${path} failed with ${grpcStatusName(error.code)}: ${error.message}`;
    if (isServerSideGrpcStatus(error.code)) {
      this.logger.error(summary, exception instanceof Error ? exception.stack : undefined);
    } else {
      this.logger.debug(summary);
    }
    return throwError(() => error);
  }
}
