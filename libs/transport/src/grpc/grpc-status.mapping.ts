import {
  BusinessRuleViolationException,
  DomainConflictException,
  DomainException,
  type DomainExceptionOptions,
  DomainValidationException,
  EntityNotFoundException,
  ErrorCode,
  ExternalServiceException,
  errorCodeForStatus,
  isDomainException,
  OperationTimeoutException,
  PermissionDeniedException,
  pickDefined,
  ServiceUnavailableException,
  toValidationIssues,
  UnauthenticatedException,
  type ValidationIssue,
} from '@app/common';
import type { Metadata } from '@grpc/grpc-js';
import { HttpException, HttpStatus } from '@nestjs/common';
import { GrpcException, GrpcStatus, RpcException } from '@nestjs/microservices';
import { isArray, isNumber, isPlainObject, isString } from 'lodash-es';
import { TimeoutError } from 'rxjs';
import { z } from 'zod';
import {
  createErrorTrailers,
  isGrpcMetadata,
  readErrorTrailers,
  toValidationIssueList,
} from './grpc-metadata.js';
import { RpcStatusException } from './rpc-status.exception.js';

/** Canonical gRPC → HTTP mapping (grpc-gateway / Google AIP-193). */
export const GRPC_STATUS_TO_HTTP_STATUS: Readonly<Record<GrpcStatus, number>> = {
  [GrpcStatus.OK]: HttpStatus.OK,
  [GrpcStatus.CANCELLED]: 499,
  [GrpcStatus.UNKNOWN]: HttpStatus.INTERNAL_SERVER_ERROR,
  [GrpcStatus.INVALID_ARGUMENT]: HttpStatus.BAD_REQUEST,
  [GrpcStatus.DEADLINE_EXCEEDED]: HttpStatus.GATEWAY_TIMEOUT,
  [GrpcStatus.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [GrpcStatus.ALREADY_EXISTS]: HttpStatus.CONFLICT,
  [GrpcStatus.PERMISSION_DENIED]: HttpStatus.FORBIDDEN,
  [GrpcStatus.RESOURCE_EXHAUSTED]: HttpStatus.TOO_MANY_REQUESTS,
  [GrpcStatus.FAILED_PRECONDITION]: HttpStatus.BAD_REQUEST,
  [GrpcStatus.ABORTED]: HttpStatus.CONFLICT,
  [GrpcStatus.OUT_OF_RANGE]: HttpStatus.BAD_REQUEST,
  [GrpcStatus.UNIMPLEMENTED]: HttpStatus.NOT_IMPLEMENTED,
  [GrpcStatus.INTERNAL]: HttpStatus.INTERNAL_SERVER_ERROR,
  [GrpcStatus.UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
  [GrpcStatus.DATA_LOSS]: HttpStatus.INTERNAL_SERVER_ERROR,
  [GrpcStatus.UNAUTHENTICATED]: HttpStatus.UNAUTHORIZED,
};

/**
 * HTTP → gRPC status for exceptions thrown inside gRPC handlers. It is not the exact inverse of
 * the canonical table: 422 is a business rule (`FAILED_PRECONDITION`), and 502 maps to
 * `INTERNAL` rather than `UNAVAILABLE`, because clients retry `UNAVAILABLE` automatically and a
 * failed upstream side effect must not be replayed.
 */
export const HTTP_STATUS_TO_GRPC_STATUS: Readonly<Partial<Record<number, GrpcStatus>>> = {
  [HttpStatus.BAD_REQUEST]: GrpcStatus.INVALID_ARGUMENT,
  [HttpStatus.UNAUTHORIZED]: GrpcStatus.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: GrpcStatus.PERMISSION_DENIED,
  [HttpStatus.NOT_FOUND]: GrpcStatus.NOT_FOUND,
  [HttpStatus.METHOD_NOT_ALLOWED]: GrpcStatus.UNIMPLEMENTED,
  [HttpStatus.REQUEST_TIMEOUT]: GrpcStatus.DEADLINE_EXCEEDED,
  [HttpStatus.CONFLICT]: GrpcStatus.ALREADY_EXISTS,
  [HttpStatus.PRECONDITION_FAILED]: GrpcStatus.FAILED_PRECONDITION,
  [HttpStatus.PAYLOAD_TOO_LARGE]: GrpcStatus.OUT_OF_RANGE,
  [HttpStatus.UNPROCESSABLE_ENTITY]: GrpcStatus.FAILED_PRECONDITION,
  [HttpStatus.TOO_MANY_REQUESTS]: GrpcStatus.RESOURCE_EXHAUSTED,
  499: GrpcStatus.CANCELLED,
  [HttpStatus.INTERNAL_SERVER_ERROR]: GrpcStatus.INTERNAL,
  [HttpStatus.NOT_IMPLEMENTED]: GrpcStatus.UNIMPLEMENTED,
  [HttpStatus.BAD_GATEWAY]: GrpcStatus.INTERNAL,
  [HttpStatus.SERVICE_UNAVAILABLE]: GrpcStatus.UNAVAILABLE,
  [HttpStatus.GATEWAY_TIMEOUT]: GrpcStatus.DEADLINE_EXCEEDED,
};

/**
 * Statuses whose `details` a client must never show: they come from the server or network side,
 * and grpc-js fills them with text such as `"… ECONNREFUSED 10.0.3.7:50051"` (nest-distributed
 * §9.19). This is every code that maps to 5xx, plus CANCELLED.
 */
const SERVER_SIDE_STATUSES: ReadonlySet<number> = new Set([
  GrpcStatus.CANCELLED,
  GrpcStatus.UNKNOWN,
  GrpcStatus.DEADLINE_EXCEEDED,
  GrpcStatus.UNIMPLEMENTED,
  GrpcStatus.INTERNAL,
  GrpcStatus.UNAVAILABLE,
  GrpcStatus.DATA_LOSS,
]);

const UPSTREAM_TIMEOUT_MESSAGE = 'The upstream service did not respond in time';
const UPSTREAM_UNAVAILABLE_MESSAGE = 'The upstream service is temporarily unavailable';
const UPSTREAM_FAILURE_MESSAGE = 'The upstream service failed';

/** Client-facing messages that replace the `details` of server-side statuses. */
const GENERIC_UPSTREAM_MESSAGES: Readonly<Partial<Record<number, string>>> = {
  [GrpcStatus.CANCELLED]: 'The upstream call was cancelled',
  [GrpcStatus.DEADLINE_EXCEEDED]: UPSTREAM_TIMEOUT_MESSAGE,
  [GrpcStatus.UNIMPLEMENTED]: 'The upstream operation is not implemented',
  [GrpcStatus.UNAVAILABLE]: UPSTREAM_UNAVAILABLE_MESSAGE,
};
const INTERNAL_ERROR_MESSAGE = 'Internal server error';

/** Widens a status number from the wire to the enum type (numbers are assignable to numeric enums). */
const toGrpcStatus = (code: number): GrpcStatus => code;

/** `GrpcStatus.NOT_FOUND` → `'NOT_FOUND'` (for logs); unknown numbers are returned as strings. */
export const grpcStatusName = (code: number): string => GrpcStatus[code] ?? String(code);

/** Whether a status is server-side (5xx-class or CANCELLED), i.e. its details must be hidden. */
export const isServerSideGrpcStatus = (code: number): boolean => SERVER_SIDE_STATUSES.has(code);

/** HTTP status for a gRPC status; unknown codes (from a newer peer) are a 500. */
export function httpStatusFromGrpcStatus(code: number): number {
  return Object.hasOwn(GRPC_STATUS_TO_HTTP_STATUS, code)
    ? GRPC_STATUS_TO_HTTP_STATUS[toGrpcStatus(code)]
    : HttpStatus.INTERNAL_SERVER_ERROR;
}

export function grpcStatusFromHttpStatus(status: number): GrpcStatus {
  const mapped = HTTP_STATUS_TO_GRPC_STATUS[status];
  if (mapped !== undefined) return mapped;
  return status >= 400 && status < 500 ? GrpcStatus.INVALID_ARGUMENT : GrpcStatus.INTERNAL;
}

/**
 * gRPC status for a domain exception. The concrete class decides first, so two 422 classes
 * (validation vs business rule) get different codes. Any other class falls back to its
 * `httpStatus`, which also covers domain subclasses written later.
 */
export function domainExceptionToGrpcStatus(exception: DomainException): GrpcStatus {
  if (exception instanceof RpcStatusException) return exception.grpcStatus;
  if (exception instanceof DomainValidationException) return GrpcStatus.INVALID_ARGUMENT;
  if (exception instanceof BusinessRuleViolationException) return GrpcStatus.FAILED_PRECONDITION;
  if (exception instanceof EntityNotFoundException) return GrpcStatus.NOT_FOUND;
  if (exception instanceof DomainConflictException) return GrpcStatus.ALREADY_EXISTS;
  return grpcStatusFromHttpStatus(exception.httpStatus);
}

export interface GrpcDomainExceptionOptions {
  /** Domain error code from the `x-error-code` trailer. It overrides the class default. */
  errorCode?: string | undefined;
  /** Client-safe details from the `x-error-details-bin` trailer. */
  details?: Record<string, unknown> | undefined;
  cause?: unknown;
}

const stringDetail = (
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = details?.[key];
  return isString(value) && value.length > 0 ? value : undefined;
};

/**
 * Rebuilds the `DomainException` that a gRPC status stands for. With the trailers written by
 * `DomainToGrpcExceptionFilter`, the rebuilt exception has the same class, code, message and
 * details as the one the server threw, so a gateway answers exactly like the monolith would.
 * `message` is used as given. `grpcErrorToDomainException` hides it for server-side statuses.
 */
export function grpcStatusToDomainException(
  code: number,
  message: string,
  options: GrpcDomainExceptionOptions = {},
): DomainException {
  const { errorCode, details } = options;
  const base: DomainExceptionOptions = pickDefined({
    code: errorCode,
    details,
    cause: options.cause,
  });

  // Numbers from the wire are compared against the enum; anything unknown hits `default`.
  switch (toGrpcStatus(code)) {
    case GrpcStatus.INVALID_ARGUMENT:
    case GrpcStatus.OUT_OF_RANGE: {
      const issues = toValidationIssueList(details?.['issues']);
      return new DomainValidationException(message, issues ? { ...base, issues } : base);
    }
    case GrpcStatus.NOT_FOUND: {
      const exception = new EntityNotFoundException(
        stringDetail(details, 'entity') ?? 'Resource',
        stringDetail(details, 'id') ?? 'unknown',
        base,
      );
      // Keep the upstream wording (EntityNotFoundException builds its own from entity + id).
      if (message.length > 0) exception.message = message;
      return exception;
    }
    case GrpcStatus.ALREADY_EXISTS:
    case GrpcStatus.ABORTED:
      return new DomainConflictException(message, base);
    case GrpcStatus.PERMISSION_DENIED:
      return new PermissionDeniedException(message, base);
    case GrpcStatus.UNAUTHENTICATED:
      return new UnauthenticatedException(message, base);
    case GrpcStatus.FAILED_PRECONDITION:
      return new BusinessRuleViolationException(message, base);
    case GrpcStatus.DEADLINE_EXCEEDED:
      return new OperationTimeoutException(message, base);
    case GrpcStatus.UNAVAILABLE:
    case GrpcStatus.CANCELLED:
      return new ServiceUnavailableException(message, base);
    case GrpcStatus.RESOURCE_EXHAUSTED:
      return new RpcStatusException(
        GrpcStatus.RESOURCE_EXHAUSTED,
        HttpStatus.TOO_MANY_REQUESTS,
        ErrorCode.RATE_LIMITED,
        message,
        base,
      );
    case GrpcStatus.UNIMPLEMENTED:
      return new RpcStatusException(
        GrpcStatus.UNIMPLEMENTED,
        HttpStatus.NOT_IMPLEMENTED,
        'NOT_IMPLEMENTED',
        message,
        base,
      );
    default:
      // UNKNOWN, INTERNAL, DATA_LOSS (and OK, which must never reach here): from a gateway's point
      // of view the upstream failed, which is a 502 rather than our own 500.
      return new ExternalServiceException(message, base);
  }
}

/** Shape of a grpc-js `ServiceError`. `ClientGrpcProxy` rethrows it unchanged. */
export interface GrpcServiceErrorLike {
  code: number;
  details: string;
  message: string;
  metadata?: Metadata | undefined;
}

export function isGrpcServiceError(error: unknown): error is GrpcServiceErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    isNumber((error as { code?: unknown }).code) &&
    isString((error as { details?: unknown }).details)
  );
}

/** opossum rejects with plain `Error`s tagged by `code` (there are no error classes). */
const BREAKER_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'EOPENBREAKER',
  'ESEMLOCKED',
  'ESHUTDOWN',
]);

const stringCodeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return isString(code) ? code : undefined;
};

/**
 * Maps whatever a client-side gRPC call rejected with to a `DomainException`:
 * - `DomainException` is returned as is.
 * - rxjs `TimeoutError` → `OperationTimeoutException` (504).
 * - An open breaker, full bulkhead or shut-down breaker → `ServiceUnavailableException` (503).
 * - A grpc-js `ServiceError` → `grpcStatusToDomainException`, with trailers applied. Server-side
 *   statuses get a generic message and no upstream details.
 * - Anything else → `ExternalServiceException` (502).
 * `operation` is recorded in `details` for logs. Problem details never render it.
 */
export function grpcErrorToDomainException(
  error: unknown,
  operation = 'grpc call',
): DomainException {
  if (isDomainException(error)) return error;
  if (error instanceof TimeoutError || stringCodeOf(error) === 'ETIMEDOUT') {
    return new OperationTimeoutException(UPSTREAM_TIMEOUT_MESSAGE, {
      cause: error,
      details: { operation },
    });
  }
  const breakerCode = stringCodeOf(error);
  if (breakerCode !== undefined && BREAKER_UNAVAILABLE_CODES.has(breakerCode)) {
    return new ServiceUnavailableException(UPSTREAM_UNAVAILABLE_MESSAGE, {
      cause: error,
      details: { operation, reason: breakerCode },
    });
  }
  if (isGrpcServiceError(error)) {
    const trailers = readErrorTrailers(error.metadata);
    if (isServerSideGrpcStatus(error.code)) {
      return grpcStatusToDomainException(
        error.code,
        GENERIC_UPSTREAM_MESSAGES[error.code] ?? UPSTREAM_FAILURE_MESSAGE,
        {
          errorCode: trailers.code,
          details: { operation, grpcStatus: grpcStatusName(error.code) },
          cause: error,
        },
      );
    }
    return grpcStatusToDomainException(error.code, error.details, {
      errorCode: trailers.code,
      details: trailers.details,
      cause: error,
    });
  }
  return new ExternalServiceException(UPSTREAM_FAILURE_MESSAGE, {
    cause: error,
    details: { operation },
  });
}

/** What a gRPC handler's error observable must emit for grpc-js to send a proper status. */
export interface GrpcErrorResponse {
  code: GrpcStatus;
  message: string;
  /** Sent as trailers. grpc-js reads `error.metadata` in `serverErrorToStatus`. */
  metadata?: Metadata;
}

export interface GrpcErrorMappingOptions {
  /** Reveal messages of unexpected errors. Keep it `false` in production. */
  exposeInternal?: boolean;
}

function withTrailers(
  code: GrpcStatus,
  message: string,
  errorCode: string | undefined,
  details: Record<string, unknown> | undefined,
): GrpcErrorResponse {
  // Details of server-side failures may describe internals: only the stable code crosses the wire.
  const metadata = createErrorTrailers({
    code: errorCode,
    details: isServerSideGrpcStatus(code) ? undefined : details,
  });
  return metadata ? { code, message, metadata } : { code, message };
}

/** Joins Nest's `string | string[]` messages, e.g. the default ValidationPipe list. */
function httpExceptionMessage(response: string | object, fallback: string): string {
  if (isString(response)) return response;
  const message = (response as { message?: unknown }).message;
  if (isString(message)) return message;
  if (isArray(message) && message.every(isString)) return message.join('; ');
  return fallback;
}

function fromHttpException(exception: HttpException, exposeInternal: boolean): GrpcErrorResponse {
  const status = exception.getStatus();
  const code = grpcStatusFromHttpStatus(status);
  const response = exception.getResponse();
  // `@app/common` validation pipes send `{ message, errors: ValidationIssue[] }`.
  const errors = isPlainObject(response)
    ? toValidationIssueList((response as { errors?: unknown }).errors)
    : undefined;
  const hasIssues = errors !== undefined && errors.length > 0;
  const message =
    status >= 500 && !exposeInternal
      ? INTERNAL_ERROR_MESSAGE
      : httpExceptionMessage(response, exception.message);
  const errorCode =
    exception.errorCode ??
    (hasIssues && status === 400 ? ErrorCode.VALIDATION_FAILED : errorCodeForStatus(status));
  return withTrailers(code, message, errorCode, hasIssues ? { issues: errors } : undefined);
}

function fromRpcException(exception: RpcException): GrpcErrorResponse {
  const error = exception.getError();
  if (isPlainObject(error)) {
    const { code, status, metadata } = error as {
      code?: unknown;
      status?: unknown;
      metadata?: unknown;
    };
    const numeric = isNumber(code) ? code : isNumber(status) ? status : undefined;
    if (numeric !== undefined) {
      return isGrpcMetadata(metadata)
        ? { code: numeric, message: exception.message, metadata }
        : { code: numeric, message: exception.message };
    }
  }
  // Nest's own GrpcExceptionFilter treats a bare RpcException as UNKNOWN. Keep that behaviour.
  return { code: GrpcStatus.UNKNOWN, message: exception.message };
}

/**
 * Converts anything thrown by a gRPC handler, pipe, guard or interceptor into the error object
 * grpc-js turns into a status:
 * - `DomainException` → mapped status + message + `x-error-code` / `x-error-details-bin` trailers.
 * - Nest `GrpcException` / `RpcException({ code })` → pass through.
 * - `HttpException` (shared ValidationPipe, guards) → mapped status. Validation `errors` become
 *   issues, and 5xx messages are hidden.
 * - zod errors → `INVALID_ARGUMENT` with issues.
 * - anything else → `INTERNAL` with a generic message, unless `exposeInternal` is set.
 */
export function exceptionToGrpcError(
  exception: unknown,
  options: GrpcErrorMappingOptions = {},
): GrpcErrorResponse {
  const exposeInternal = options.exposeInternal ?? false;
  if (exception instanceof DomainException) {
    return withTrailers(
      domainExceptionToGrpcStatus(exception),
      exception.message,
      exception.code,
      exception.details,
    );
  }
  if (exception instanceof GrpcException) {
    return { code: exception.getCode(), message: exception.message };
  }
  if (exception instanceof RpcException) {
    return fromRpcException(exception);
  }
  if (exception instanceof HttpException) return fromHttpException(exception, exposeInternal);
  if (exception instanceof z.core.$ZodError) {
    const issues: ValidationIssue[] = toValidationIssues(exception.issues);
    return withTrailers(
      GrpcStatus.INVALID_ARGUMENT,
      'Validation failed',
      ErrorCode.VALIDATION_FAILED,
      {
        issues,
      },
    );
  }
  const message =
    exposeInternal && exception instanceof Error ? exception.message : INTERNAL_ERROR_MESSAGE;
  return { code: GrpcStatus.INTERNAL, message };
}
