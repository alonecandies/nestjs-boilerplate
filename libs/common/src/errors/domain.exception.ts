import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes.js';
import { type IssueLike, toValidationIssues, type ValidationIssue } from './validation-issue.js';

export interface DomainExceptionOptions {
  /** Structured, client-safe context (entity ids, limits…). Never put secrets or PII here. */
  details?: Record<string, unknown>;
  /** The underlying error (kept for logs; never serialized to clients). */
  cause?: unknown;
  /** Overrides the class' default `code` for one-off cases that don't deserve a subclass. */
  code?: string;
}

/**
 * Base class of every error thrown by domain/application code. It carries a stable machine
 * `code` and the HTTP status it maps to, but is transport-agnostic: the HTTP filter renders it as
 * problem+json, the gRPC filter maps it to a status code, GraphQL puts `code` in `extensions`.
 * Throwing `HttpException` from domain code is forbidden — it couples the core to HTTP.
 *
 * Subclass one of the concrete classes below and override `code` for domain-specific errors:
 * `class EmailAlreadyTakenException extends DomainConflictException { override readonly code = 'EMAIL_TAKEN'; }`
 */
export abstract class DomainException extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: HttpStatus;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options?: DomainExceptionOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    // `new.target` keeps the concrete subclass name in logs/stack traces (class names survive SWC).
    this.name = new.target.name;
    if (options?.details !== undefined) this.details = options.details;
  }
}

/** Type guard usable across transports (filters, gRPC mappers, GraphQL formatters). */
export const isDomainException = (value: unknown): value is DomainException =>
  value instanceof DomainException;

/** 404 — `${entity} "${id}" was not found`. */
export class EntityNotFoundException extends DomainException {
  override readonly code: string;
  override readonly httpStatus: HttpStatus = HttpStatus.NOT_FOUND;

  constructor(
    readonly entity: string,
    readonly entityId: string,
    options?: DomainExceptionOptions,
  ) {
    super(`${entity} "${entityId}" was not found`, {
      ...options,
      details: { entity, id: entityId, ...options?.details },
    });
    this.code = options?.code ?? ErrorCode.NOT_FOUND;
  }
}

/** 409 — the request conflicts with the current state (unique constraint, version mismatch…). */
export class DomainConflictException extends DomainException {
  override readonly code: string;
  override readonly httpStatus: HttpStatus = HttpStatus.CONFLICT;

  constructor(
    message = 'The request conflicts with the current state',
    options?: DomainExceptionOptions,
  ) {
    super(message, options);
    this.code = options?.code ?? ErrorCode.CONFLICT;
  }
}

export interface DomainValidationExceptionOptions extends DomainExceptionOptions {
  issues?: readonly ValidationIssue[];
}

/**
 * 422 — semantically invalid input detected by the domain (or by transport-level zod pipes).
 * `details.issues` is rendered as `ProblemDetails.errors`.
 */
export class DomainValidationException extends DomainException {
  override readonly code: string;
  override readonly httpStatus: HttpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: readonly ValidationIssue[];

  constructor(message = 'Validation failed', options?: DomainValidationExceptionOptions) {
    const issues = options?.issues ?? [];
    super(message, { ...options, details: { ...options?.details, issues } });
    this.issues = issues;
    this.code = options?.code ?? ErrorCode.VALIDATION_FAILED;
  }

  /** Builds the exception from zod / Standard Schema issues. */
  static fromIssues(
    issues: readonly IssueLike[],
    message = 'Validation failed',
    options?: Omit<DomainValidationExceptionOptions, 'issues'>,
  ): DomainValidationException {
    return new DomainValidationException(message, {
      ...options,
      issues: toValidationIssues(issues),
    });
  }
}

/** 401 — missing/invalid/expired credentials. */
export class UnauthenticatedException extends DomainException {
  override readonly code: string;
  override readonly httpStatus: HttpStatus = HttpStatus.UNAUTHORIZED;

  constructor(message = 'Authentication is required', options?: DomainExceptionOptions) {
    super(message, options);
    this.code = options?.code ?? ErrorCode.UNAUTHENTICATED;
  }
}

/** 403 — authenticated but not allowed. */
export class PermissionDeniedException extends DomainException {
  override readonly code: string;
  override readonly httpStatus: HttpStatus = HttpStatus.FORBIDDEN;

  constructor(
    message = 'You do not have permission to perform this action',
    options?: DomainExceptionOptions,
  ) {
    super(message, options);
    this.code = options?.code ?? ErrorCode.FORBIDDEN;
  }
}

/** 422 — well-formed request that violates a business invariant (e.g. removing your own admin role). */
export class BusinessRuleViolationException extends DomainException {
  override readonly code: string;
  override readonly httpStatus: HttpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor(message = 'A business rule was violated', options?: DomainExceptionOptions) {
    super(message, options);
    this.code = options?.code ?? ErrorCode.BUSINESS_RULE_VIOLATION;
  }
}

/** 502 — an upstream dependency (Stripe, SMTP, another service) failed. */
export class ExternalServiceException extends DomainException {
  override readonly code: string;
  override readonly httpStatus: HttpStatus = HttpStatus.BAD_GATEWAY;

  constructor(message = 'An upstream service failed', options?: DomainExceptionOptions) {
    super(message, options);
    this.code = options?.code ?? ErrorCode.EXTERNAL_SERVICE_ERROR;
  }
}

/**
 * 503 — temporarily unable to serve (maintenance, open circuit breaker, draining).
 * NOTE: shares its name with `@nestjs/common`'s HTTP exception — alias one of them on import.
 */
export class ServiceUnavailableException extends DomainException {
  override readonly code: string;
  override readonly httpStatus: HttpStatus = HttpStatus.SERVICE_UNAVAILABLE;

  constructor(
    message = 'The service is temporarily unavailable',
    options?: DomainExceptionOptions,
  ) {
    super(message, options);
    this.code = options?.code ?? ErrorCode.SERVICE_UNAVAILABLE;
  }
}

/** 504 — an operation exceeded its deadline (request timeout, gRPC deadline…). */
export class OperationTimeoutException extends DomainException {
  override readonly code: string;
  override readonly httpStatus: HttpStatus = HttpStatus.GATEWAY_TIMEOUT;

  constructor(message = 'The operation timed out', options?: DomainExceptionOptions) {
    super(message, options);
    this.code = options?.code ?? ErrorCode.TIMEOUT;
  }
}
