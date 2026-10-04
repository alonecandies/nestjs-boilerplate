import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BusinessRuleViolationException,
  DomainConflictException,
  DomainException,
  DomainValidationException,
  EntityNotFoundException,
  ExternalServiceException,
  isDomainException,
  OperationTimeoutException,
  PermissionDeniedException,
  ServiceUnavailableException,
  UnauthenticatedException,
} from './domain.exception.js';

class EmailAlreadyTakenException extends DomainConflictException {
  override readonly code = 'EMAIL_TAKEN';
}

describe('DomainException family', () => {
  it.each([
    [new EntityNotFoundException('User', '42'), 404, 'NOT_FOUND'],
    [new DomainConflictException(), 409, 'CONFLICT'],
    [new DomainValidationException(), 422, 'VALIDATION_FAILED'],
    [new UnauthenticatedException(), 401, 'UNAUTHENTICATED'],
    [new PermissionDeniedException(), 403, 'FORBIDDEN'],
    [new BusinessRuleViolationException(), 422, 'BUSINESS_RULE_VIOLATION'],
    [new ExternalServiceException(), 502, 'EXTERNAL_SERVICE_ERROR'],
    [new ServiceUnavailableException(), 503, 'SERVICE_UNAVAILABLE'],
    [new OperationTimeoutException(), 504, 'TIMEOUT'],
  ])('%s maps to %i %s', (error, status, code) => {
    expect(error).toBeInstanceOf(DomainException);
    expect(error).toBeInstanceOf(Error);
    expect(isDomainException(error)).toBe(true);
    expect(error.httpStatus).toBe(status);
    expect(error.code).toBe(code);
    expect(error.name).toBe(error.constructor.name);
  });

  it('lets subclasses refine the code', () => {
    const error = new EmailAlreadyTakenException('Email is already registered');
    expect(error.code).toBe('EMAIL_TAKEN');
    expect(error.httpStatus).toBe(409);
    expect(error.name).toBe('EmailAlreadyTakenException');
  });

  it('supports a one-off code override, details and cause', () => {
    const cause = new Error('stripe said no');
    const error = new ExternalServiceException('Payment provider failed', {
      code: 'STRIPE_ERROR',
      details: { provider: 'stripe' },
      cause,
    });
    expect(error.code).toBe('STRIPE_ERROR');
    expect(error.details).toEqual({ provider: 'stripe' });
    expect(error.cause).toBe(cause);
  });

  it('EntityNotFoundException builds a descriptive message and details', () => {
    const error = new EntityNotFoundException('User', 'abc');
    expect(error.message).toBe('User "abc" was not found');
    expect(error.details).toEqual({ entity: 'User', id: 'abc' });
  });

  it('DomainValidationException.fromIssues converts zod issues', () => {
    const result = z.object({ items: z.array(z.object({ sku: z.string() })) }).safeParse({
      items: [{ sku: 1 }],
    });
    expect(result.success).toBe(false);
    const error = DomainValidationException.fromIssues(result.error?.issues ?? []);
    expect(error.issues).toEqual([
      { path: 'items.0.sku', message: expect.any(String) as string, code: 'invalid_type' },
    ]);
    expect(error.details?.['issues']).toBe(error.issues);
  });

  it('isDomainException rejects plain errors', () => {
    expect(isDomainException(new Error('x'))).toBe(false);
    expect(isDomainException({ code: 'X', httpStatus: 400 })).toBe(false);
  });
});
