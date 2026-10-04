import { isDomainException, toProblemDetails } from '@app/common';
import { HttpException } from '@nestjs/common';
import { isNumber, isPlainObject, isString } from 'lodash-es';
import type { LevelWithSilent } from 'pino';

/**
 * gRPC status codes that describe a CALLER mistake (the 4xx class of the canonical gRPC → HTTP
 * table): INVALID_ARGUMENT, NOT_FOUND, ALREADY_EXISTS, PERMISSION_DENIED, RESOURCE_EXHAUSTED,
 * FAILED_PRECONDITION, ABORTED, OUT_OF_RANGE, UNAUTHENTICATED.
 */
const CLIENT_GRPC_STATUSES: ReadonlySet<number> = new Set([3, 5, 6, 7, 8, 9, 10, 11, 16]);

/** `RpcException({ code })` / `GrpcException` (duck-typed: no `@nestjs/microservices` dependency). */
function grpcStatusOf(error: Error): number | undefined {
  const { getError } = error as { getError?: unknown };
  if (typeof getError !== 'function') return undefined;
  const inner: unknown = getError.call(error);
  if (!isPlainObject(inner)) return undefined;
  const code = (inner as { code?: unknown }).code;
  return isNumber(code) ? code : undefined;
}

/** zod v4 errors (classic `ZodError` or core `$ZodError`), thrown by schema parsing in handlers. */
const isZodError = (error: Error): boolean =>
  (error.name === 'ZodError' || error.name === '$ZodError') &&
  Array.isArray((error as { issues?: unknown }).issues);

/**
 * Whether a gRPC/Kafka handler failed because of the CALLER (unknown entity, duplicate email, bad
 * credentials, validation…) rather than because the service is broken. The pre-request hook sees
 * the raw error BEFORE any `@Catch()` filter maps it, so the domain/HTTP status decides.
 */
export function isRpcClientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const grpcStatus = grpcStatusOf(error);
  if (grpcStatus !== undefined) return CLIENT_GRPC_STATUSES.has(grpcStatus);
  if (isZodError(error)) return true;
  return toProblemDetails(error, { exposeInternal: false }).status < 500;
}

/**
 * nestjs-pino `microservice.customLogLevel`: like HTTP (`warn` for 4xx), a caller error is a `warn`,
 * not an `error` — otherwise every NOT_FOUND / EMAIL_TAKEN / INVALID_CREDENTIALS would page.
 * Server-side failures (5xx-class, unknown errors) stay `error`.
 */
export function rpcLogLevel(_context: unknown, error?: Error): LevelWithSilent {
  if (error === undefined) return 'info';
  return isRpcClientError(error) ? 'warn' : 'error';
}

/** The stable machine code of an error, when it has one (domain `code`, Nest `errorCode`). */
function errorCodeOf(error: Error): string | undefined {
  if (isDomainException(error)) return error.code;
  if (error instanceof HttpException) return error.errorCode;
  const code = (error as { code?: unknown }).code;
  return isString(code) ? code : undefined;
}

/**
 * nestjs-pino `microservice.customErrorObject`: caller errors are logged WITHOUT a stack (it only
 * points into the framework and costs a multi-line blob per expected failure) — as
 * `error: { type, message, code }` instead of `err`, because pino's `err` serializer would turn
 * any `{ message }` object back into an error record (`type: 'Object'`, empty `stack`).
 * Server-side failures keep the full serialized `err`.
 */
export function rpcErrorObject(_context: unknown, error: Error, value: object): object {
  if (!isRpcClientError(error)) return value;
  const { err: _dropped, ...rest } = value as { err?: unknown };
  const code = errorCodeOf(error);
  return {
    ...rest,
    error: { type: error.name, message: error.message, ...(code === undefined ? {} : { code }) },
  };
}
