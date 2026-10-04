import {
  BusinessRuleViolationException,
  DomainConflictException,
  type DomainException,
  DomainValidationException,
  EntityNotFoundException,
  ErrorCode,
  ExternalServiceException,
  OperationTimeoutException,
  PermissionDeniedException,
  ServiceUnavailableException,
  UnauthenticatedException,
} from '@app/common';
import { Metadata } from '@grpc/grpc-js';
import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  InternalServerErrorException,
} from '@nestjs/common';
import { GrpcNotFoundException, GrpcStatus, RpcException } from '@nestjs/microservices';
import { lastValueFrom, NEVER, TimeoutError, timeout } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  domainExceptionToGrpcStatus,
  exceptionToGrpcError,
  GRPC_STATUS_TO_HTTP_STATUS,
  type GrpcErrorResponse,
  type GrpcServiceErrorLike,
  grpcErrorToDomainException,
  grpcStatusFromHttpStatus,
  grpcStatusName,
  grpcStatusToDomainException,
  httpStatusFromGrpcStatus,
  isGrpcServiceError,
  isServerSideGrpcStatus,
} from './grpc-status.mapping.js';
import { RpcStatusException } from './rpc-status.exception.js';

class EmailTakenException extends DomainConflictException {
  override readonly code = 'EMAIL_TAKEN';
}

/** What a gateway receives for a server-side `GrpcErrorResponse` (grpc-js `ServiceError`). */
const toServiceError = (response: GrpcErrorResponse): GrpcServiceErrorLike => ({
  code: response.code,
  details: response.message,
  message: `${response.code} ${GrpcStatus[response.code]}: ${response.message}`,
  metadata: response.metadata ?? new Metadata(),
});

const serviceError = (code: GrpcStatus, details: string): GrpcServiceErrorLike => ({
  code,
  details,
  message: `${code} ${GrpcStatus[code]}: ${details}`,
  metadata: new Metadata(),
});

describe('gRPC ↔ HTTP tables', () => {
  it.each([
    [GrpcStatus.OK, 200],
    [GrpcStatus.CANCELLED, 499],
    [GrpcStatus.UNKNOWN, 500],
    [GrpcStatus.INVALID_ARGUMENT, 400],
    [GrpcStatus.DEADLINE_EXCEEDED, 504],
    [GrpcStatus.NOT_FOUND, 404],
    [GrpcStatus.ALREADY_EXISTS, 409],
    [GrpcStatus.PERMISSION_DENIED, 403],
    [GrpcStatus.RESOURCE_EXHAUSTED, 429],
    [GrpcStatus.FAILED_PRECONDITION, 400],
    [GrpcStatus.ABORTED, 409],
    [GrpcStatus.OUT_OF_RANGE, 400],
    [GrpcStatus.UNIMPLEMENTED, 501],
    [GrpcStatus.INTERNAL, 500],
    [GrpcStatus.UNAVAILABLE, 503],
    [GrpcStatus.DATA_LOSS, 500],
    [GrpcStatus.UNAUTHENTICATED, 401],
  ])('maps gRPC %s to HTTP %s (canonical table)', (code, http) => {
    expect(httpStatusFromGrpcStatus(code)).toBe(http);
    expect(GRPC_STATUS_TO_HTTP_STATUS[code]).toBe(http);
  });

  it('treats unknown gRPC codes as 500', () => {
    expect(httpStatusFromGrpcStatus(42)).toBe(500);
    expect(grpcStatusName(42)).toBe('42');
    expect(grpcStatusName(GrpcStatus.NOT_FOUND)).toBe('NOT_FOUND');
  });

  it.each([
    [400, GrpcStatus.INVALID_ARGUMENT],
    [401, GrpcStatus.UNAUTHENTICATED],
    [403, GrpcStatus.PERMISSION_DENIED],
    [404, GrpcStatus.NOT_FOUND],
    [409, GrpcStatus.ALREADY_EXISTS],
    [422, GrpcStatus.FAILED_PRECONDITION],
    [429, GrpcStatus.RESOURCE_EXHAUSTED],
    [500, GrpcStatus.INTERNAL],
    [502, GrpcStatus.INTERNAL],
    [503, GrpcStatus.UNAVAILABLE],
    [504, GrpcStatus.DEADLINE_EXCEEDED],
    [418, GrpcStatus.INVALID_ARGUMENT],
    [599, GrpcStatus.INTERNAL],
  ])('maps HTTP %s to gRPC %s', (http, code) => {
    expect(grpcStatusFromHttpStatus(http)).toBe(code);
  });

  it('flags every 5xx-class status (and CANCELLED) as server-side', () => {
    const serverSide = Object.values(GrpcStatus)
      .filter((value): value is GrpcStatus => typeof value === 'number')
      .filter((code) => isServerSideGrpcStatus(code));
    expect(serverSide.sort((a, b) => a - b)).toEqual([
      GrpcStatus.CANCELLED,
      GrpcStatus.UNKNOWN,
      GrpcStatus.DEADLINE_EXCEEDED,
      GrpcStatus.UNIMPLEMENTED,
      GrpcStatus.INTERNAL,
      GrpcStatus.UNAVAILABLE,
      GrpcStatus.DATA_LOSS,
    ]);
  });
});

describe('domainExceptionToGrpcStatus', () => {
  it.each<[DomainException, GrpcStatus]>([
    [new EntityNotFoundException('User', 'u1'), GrpcStatus.NOT_FOUND],
    [new DomainConflictException('dup'), GrpcStatus.ALREADY_EXISTS],
    [new EmailTakenException('taken'), GrpcStatus.ALREADY_EXISTS],
    [new DomainValidationException('bad'), GrpcStatus.INVALID_ARGUMENT],
    [new BusinessRuleViolationException('nope'), GrpcStatus.FAILED_PRECONDITION],
    [new UnauthenticatedException(), GrpcStatus.UNAUTHENTICATED],
    [new PermissionDeniedException(), GrpcStatus.PERMISSION_DENIED],
    [new ExternalServiceException(), GrpcStatus.INTERNAL],
    [new ServiceUnavailableException(), GrpcStatus.UNAVAILABLE],
    [new OperationTimeoutException(), GrpcStatus.DEADLINE_EXCEEDED],
    [
      new RpcStatusException(
        GrpcStatus.RESOURCE_EXHAUSTED,
        429,
        ErrorCode.RATE_LIMITED,
        'slow down',
      ),
      GrpcStatus.RESOURCE_EXHAUSTED,
    ],
  ])('%s → %s', (exception, code) => {
    expect(domainExceptionToGrpcStatus(exception)).toBe(code);
  });
});

describe('grpcStatusToDomainException', () => {
  it.each<[GrpcStatus, abstract new (...args: never[]) => DomainException, number]>([
    [GrpcStatus.INVALID_ARGUMENT, DomainValidationException, 422],
    [GrpcStatus.OUT_OF_RANGE, DomainValidationException, 422],
    [GrpcStatus.NOT_FOUND, EntityNotFoundException, 404],
    [GrpcStatus.ALREADY_EXISTS, DomainConflictException, 409],
    [GrpcStatus.ABORTED, DomainConflictException, 409],
    [GrpcStatus.PERMISSION_DENIED, PermissionDeniedException, 403],
    [GrpcStatus.UNAUTHENTICATED, UnauthenticatedException, 401],
    [GrpcStatus.FAILED_PRECONDITION, BusinessRuleViolationException, 422],
    [GrpcStatus.DEADLINE_EXCEEDED, OperationTimeoutException, 504],
    [GrpcStatus.UNAVAILABLE, ServiceUnavailableException, 503],
    [GrpcStatus.CANCELLED, ServiceUnavailableException, 503],
    [GrpcStatus.RESOURCE_EXHAUSTED, RpcStatusException, 429],
    [GrpcStatus.UNIMPLEMENTED, RpcStatusException, 501],
    [GrpcStatus.INTERNAL, ExternalServiceException, 502],
    [GrpcStatus.UNKNOWN, ExternalServiceException, 502],
    [GrpcStatus.DATA_LOSS, ExternalServiceException, 502],
  ])('%s → %o (HTTP %s)', (code, type, httpStatus) => {
    const exception = grpcStatusToDomainException(code, 'upstream says no');
    expect(exception).toBeInstanceOf(type);
    expect(exception.httpStatus).toBe(httpStatus);
    expect(exception.message).toBe('upstream says no');
  });

  it('rebuilds entity details, code and validation issues', () => {
    const notFound = grpcStatusToDomainException(GrpcStatus.NOT_FOUND, 'User u1 not found', {
      errorCode: 'USER_NOT_FOUND',
      details: { entity: 'User', id: 'u1' },
    });
    expect(notFound).toMatchObject({
      code: 'USER_NOT_FOUND',
      details: { entity: 'User', id: 'u1' },
      message: 'User u1 not found',
    });

    const invalid = grpcStatusToDomainException(GrpcStatus.INVALID_ARGUMENT, 'Invalid', {
      details: {
        issues: [{ path: 'email', message: 'Invalid email', code: 'invalid_format' }, 'junk'],
      },
    });
    expect(invalid).toBeInstanceOf(DomainValidationException);
    expect((invalid as DomainValidationException).issues).toEqual([
      { path: 'email', message: 'Invalid email', code: 'invalid_format' },
    ]);
  });
});

describe('grpcErrorToDomainException (client side)', () => {
  it('passes DomainExceptions through', () => {
    const original = new EntityNotFoundException('User', 'u1');
    expect(grpcErrorToDomainException(original)).toBe(original);
  });

  it('maps rxjs and opossum timeouts to OperationTimeoutException', async () => {
    const rxjsTimeout: unknown = await lastValueFrom(NEVER.pipe(timeout(1))).catch(
      (error: unknown) => error,
    );
    expect(rxjsTimeout).toBeInstanceOf(TimeoutError);
    expect(grpcErrorToDomainException(rxjsTimeout, 'op')).toBeInstanceOf(OperationTimeoutException);
    const opossumTimeout = Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' });
    expect(grpcErrorToDomainException(opossumTimeout)).toBeInstanceOf(OperationTimeoutException);
  });

  it.each(['EOPENBREAKER', 'ESEMLOCKED', 'ESHUTDOWN'])(
    'maps breaker rejection %s to 503 with the reason in details',
    (code) => {
      const exception = grpcErrorToDomainException(
        Object.assign(new Error('Breaker is open'), { code }),
        'identity.GetUser',
      );
      expect(exception).toBeInstanceOf(ServiceUnavailableException);
      expect(exception.details).toEqual({ operation: 'identity.GetUser', reason: code });
    },
  );

  it('keeps upstream messages for client-side statuses', () => {
    const exception = grpcErrorToDomainException(
      serviceError(GrpcStatus.NOT_FOUND, 'User u1 not found'),
    );
    expect(exception).toBeInstanceOf(EntityNotFoundException);
    expect(exception.message).toBe('User u1 not found');
  });

  it.each([
    [GrpcStatus.UNAVAILABLE, ServiceUnavailableException],
    [GrpcStatus.INTERNAL, ExternalServiceException],
    [GrpcStatus.UNKNOWN, ExternalServiceException],
    [GrpcStatus.DATA_LOSS, ExternalServiceException],
    [GrpcStatus.DEADLINE_EXCEEDED, OperationTimeoutException],
  ])('hides upstream details for server-side status %s', (code, type) => {
    const leaky = 'No connection established. Last error: connect ECONNREFUSED 10.0.3.7:50051';
    const exception = grpcErrorToDomainException(serviceError(code, leaky), 'identity.GetUser');
    expect(exception).toBeInstanceOf(type);
    expect(exception.message).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(exception.details)).not.toContain('10.0.3.7');
    expect(exception.details).toMatchObject({ operation: 'identity.GetUser' });
  });

  it('maps anything else to ExternalServiceException', () => {
    expect(grpcErrorToDomainException(new Error('boom'))).toBeInstanceOf(ExternalServiceException);
    expect(grpcErrorToDomainException('boom')).toBeInstanceOf(ExternalServiceException);
  });

  it('recognises grpc-js service errors structurally', () => {
    expect(isGrpcServiceError(serviceError(GrpcStatus.NOT_FOUND, 'x'))).toBe(true);
    expect(isGrpcServiceError(new Error('x'))).toBe(false);
    expect(isGrpcServiceError({ code: 'ENOENT', details: 'x' })).toBe(false);
  });
});

describe('exceptionToGrpcError (server side)', () => {
  it('maps a DomainException to status + message + trailers', () => {
    const response = exceptionToGrpcError(new EmailTakenException('Email already registered'));
    expect(response.code).toBe(GrpcStatus.ALREADY_EXISTS);
    expect(response.message).toBe('Email already registered');
    expect(response.metadata?.get('x-error-code')).toEqual(['EMAIL_TAKEN']);
  });

  it('never sends details of server-side domain failures', () => {
    const response = exceptionToGrpcError(
      new ExternalServiceException('Stripe failed', { details: { stripeRequestId: 'req_1' } }),
    );
    expect(response.code).toBe(GrpcStatus.INTERNAL);
    expect(response.metadata?.get('x-error-details-bin')).toEqual([]);
    expect(response.metadata?.get('x-error-code')).toEqual([ErrorCode.EXTERNAL_SERVICE_ERROR]);
  });

  it('passes Nest GrpcException and RpcException({ code }) through', () => {
    expect(exceptionToGrpcError(new GrpcNotFoundException('gone'))).toEqual({
      code: GrpcStatus.NOT_FOUND,
      message: 'gone',
    });
    expect(
      exceptionToGrpcError(new RpcException({ code: GrpcStatus.ABORTED, message: 'retry later' })),
    ).toMatchObject({ code: GrpcStatus.ABORTED, message: 'retry later' });
    expect(exceptionToGrpcError(new RpcException('bare')).code).toBe(GrpcStatus.UNKNOWN);
  });

  it('maps HttpExceptions, turning structured validation errors into issues', () => {
    const validation = exceptionToGrpcError(
      new BadRequestException({
        message: 'Request validation failed',
        errors: [{ path: 'email', message: 'must be an email' }],
      }),
    );
    expect(validation.code).toBe(GrpcStatus.INVALID_ARGUMENT);
    expect(validation.metadata?.get('x-error-code')).toEqual([ErrorCode.VALIDATION_FAILED]);

    const forbidden = exceptionToGrpcError(new ForbiddenException('No access'));
    expect(forbidden).toMatchObject({ code: GrpcStatus.PERMISSION_DENIED, message: 'No access' });

    const internal = exceptionToGrpcError(new InternalServerErrorException('db password wrong'));
    expect(internal).toMatchObject({ code: GrpcStatus.INTERNAL, message: 'Internal server error' });
  });

  it('maps zod errors to INVALID_ARGUMENT', () => {
    const error = z.object({ id: z.uuid() }).safeParse({ id: 'nope' }).error;
    const response = exceptionToGrpcError(error);
    expect(response.code).toBe(GrpcStatus.INVALID_ARGUMENT);
    expect(response.metadata?.get('x-error-code')).toEqual([ErrorCode.VALIDATION_FAILED]);
  });

  it('hides unexpected error messages unless exposeInternal', () => {
    const error = new Error('connect ECONNREFUSED 10.0.0.5:5432');
    expect(exceptionToGrpcError(error)).toEqual({
      code: GrpcStatus.INTERNAL,
      message: 'Internal server error',
    });
    expect(exceptionToGrpcError(error, { exposeInternal: true }).message).toContain('ECONNREFUSED');
  });
});

describe('server → client round trip (mapping only)', () => {
  type DomainExceptionClass = abstract new (...args: never[]) => DomainException;
  it.each<[string, DomainException, DomainExceptionClass]>([
    [
      'not found',
      new EntityNotFoundException('User', 'u1', { code: 'USER_NOT_FOUND' }),
      EntityNotFoundException,
    ],
    // A domain subclass comes back as its base class, with the subclass' code.
    ['conflict', new EmailTakenException('Email already registered'), DomainConflictException],
    [
      'validation',
      new DomainValidationException('Invalid request payload', {
        issues: [{ path: 'email', message: 'Invalid email', code: 'invalid_format' }],
      }),
      DomainValidationException,
    ],
    [
      'business rule',
      new BusinessRuleViolationException('Cannot remove own admin role'),
      BusinessRuleViolationException,
    ],
    ['unauthenticated', new UnauthenticatedException('Token expired'), UnauthenticatedException],
    ['forbidden', new PermissionDeniedException('Admins only'), PermissionDeniedException],
  ])('%s keeps class, code, message and details', (_name, original, expectedType) => {
    const rebuilt = grpcErrorToDomainException(toServiceError(exceptionToGrpcError(original)));
    expect(rebuilt).toBeInstanceOf(expectedType);
    expect(rebuilt.code).toBe(original.code);
    expect(rebuilt.message).toBe(original.message);
    expect(rebuilt.httpStatus).toBe(original.httpStatus);
    expect(rebuilt.details).toEqual(original.details);
  });

  it('turns a server-side failure into a sanitized 5xx with the stable code only', () => {
    const rebuilt = grpcErrorToDomainException(
      toServiceError(exceptionToGrpcError(new Error('pg: password authentication failed'))),
      'billing.ListPayments',
    );
    expect(rebuilt).toBeInstanceOf(ExternalServiceException);
    expect(rebuilt.httpStatus).toBe(HttpStatus.BAD_GATEWAY);
    expect(rebuilt.message).not.toContain('password');
  });
});
