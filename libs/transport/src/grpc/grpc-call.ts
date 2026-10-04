import { lastValueFrom, type Observable, timeout } from 'rxjs';
import type { GrpcCircuitBreaker } from './grpc-circuit-breakers.js';
import { grpcErrorToDomainException } from './grpc-status.mapping.js';

export interface GrpcCallOptions {
  /**
   * Local deadline in ms. Unsubscribing cancels the call, so the server sees `call.cancelled`.
   * Use `grpcConfig.deadlineMs`, which is also the deadline in the service config.
   */
  timeoutMs: number;
  /** For logs and error details, e.g. `'identity.UsersService/GetUser'`. */
  operation: string;
  /** Upstream breaker from `GrpcCircuitBreakers.get(name)`. */
  breaker?: GrpcCircuitBreaker | undefined;
}

/**
 * Runs one unary gRPC call (a cold `ClientGrpc` observable) and returns its result. It applies an
 * rxjs deadline and the optional circuit breaker, and maps every failure to a `DomainException`
 * with `grpcErrorToDomainException`: `NOT_FOUND` becomes `EntityNotFoundException`, and so on,
 * with server-side details hidden. REST, GraphQL and WS error handling then treat upstream errors
 * exactly like local ones.
 *
 * The breaker sees the raw grpc-js error, so its `errorFilter` can tell caller mistakes
 * (`NOT_FOUND`, `INVALID_ARGUMENT`, …) from upstream failures. Mapping happens afterwards.
 * Only the last value is returned, so do not use this for server-streaming calls.
 */
export async function grpcCall<T>(source: Observable<T>, options: GrpcCallOptions): Promise<T> {
  const task = (): Promise<T> => lastValueFrom(source.pipe(timeout({ first: options.timeoutMs })));
  try {
    if (options.breaker === undefined) return await task();
    // The breaker's action is `(task) => task()`, so the resolved value is exactly task()'s T.
    return (await options.breaker.fire(task)) as T;
  } catch (error) {
    throw grpcErrorToDomainException(error, options.operation);
  }
}
