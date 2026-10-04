import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Observable, throwError, timeout } from 'rxjs';
import { TIMEOUT_KEY } from '../constants/metadata.constants.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from '../constants/tokens.constants.js';
import { getContextType } from '../context/execution-context.util.js';
import { OperationTimeoutException } from '../errors/domain.exception.js';

/**
 * Fails HTTP/GraphQL handlers that don't produce a response in time with a 504 `TIMEOUT` problem,
 * so a stuck dependency can't pin sockets until the load balancer gives up. Per-route override via
 * `@Timeout(ms)` (`0` disables); default from the optional `DEFAULT_TIMEOUT_MS` token.
 *
 * - Only the FIRST emission is timed (`timeout({ first })`): SSE streams and GraphQL subscription
 *   iterators are not cut off after they start.
 * - rpc/ws are skipped: gRPC has deadlines, Kafka handlers must never throw (redelivery loop).
 * - The handler's promise is not cancelled (JS can't) — the client just stops waiting.
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  private readonly defaultTimeoutMs: number;

  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(DEFAULT_TIMEOUT_MS) defaultTimeoutMs?: number,
  ) {
    this.defaultTimeoutMs = defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const type = getContextType(context);
    if (type !== 'http' && type !== 'graphql') return next.handle();

    const ms =
      this.reflector.getAllAndOverride<number | undefined>(TIMEOUT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? this.defaultTimeoutMs;
    if (!(ms > 0) || !Number.isFinite(ms)) return next.handle();

    return next.handle().pipe(
      timeout({
        first: ms,
        with: () =>
          throwError(
            () =>
              new OperationTimeoutException(`Request timed out after ${ms}ms`, {
                details: { timeoutMs: ms },
              }),
          ),
      }),
    );
  }
}
