import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  DomainConflictException,
  DomainValidationException,
  ExternalServiceException,
} from './domain.exception.js';
import { toProblemDetails } from './problem-details.js';

const ctx = { requestId: 'req-1', instance: '/v1/users', exposeInternal: false };

describe('toProblemDetails', () => {
  it('maps a DomainException with its own code, type and title', () => {
    class EmailTaken extends DomainConflictException {
      override readonly code = 'EMAIL_TAKEN';
    }
    expect(toProblemDetails(new EmailTaken('Email already registered'), ctx)).toEqual({
      type: 'https://errors.nestjs-boilerplate.dev/email-taken',
      title: 'Email Taken',
      status: 409,
      detail: 'Email already registered',
      instance: '/v1/users',
      code: 'EMAIL_TAKEN',
      requestId: 'req-1',
    });
  });

  it('exposes validation issues of 4xx domain errors as `errors`', () => {
    const issues = [{ path: 'email', message: 'Invalid email' }];
    const problem = toProblemDetails(
      new DomainValidationException('Invalid input', { issues }),
      ctx,
    );
    expect(problem).toMatchObject({ status: 422, code: 'VALIDATION_FAILED', errors: issues });
  });

  it('keeps 5xx domain messages but never their details', () => {
    const error = new ExternalServiceException('Payment provider failed', {
      details: { issues: [{ path: 'x', message: 'upstream said 10.0.0.3 refused' }] },
    });
    const problem = toProblemDetails(error, ctx);
    expect(problem).toMatchObject({ status: 502, code: 'EXTERNAL_SERVICE_ERROR' });
    expect(problem.detail).toBe('Payment provider failed');
    expect(problem.errors).toBeUndefined();
  });

  it('maps a ValidationPipe list (message: string[]) to VALIDATION_FAILED', () => {
    const exception = new BadRequestException([
      'email must be an email',
      'name should not be empty',
    ]);
    expect(toProblemDetails(exception, ctx)).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      title: 'Validation Failed',
      errors: [{ message: 'email must be an email' }, { message: 'name should not be empty' }],
    });
  });

  it('maps a grouped ValidationPipe body and our structured { errors } body', () => {
    const grouped = new BadRequestException({ message: { email: ['must be an email'] } });
    expect(toProblemDetails(grouped, ctx).errors).toEqual([
      { path: 'email', message: 'must be an email' },
    ]);
    const structured = new BadRequestException({
      message: 'Request validation failed',
      errors: [{ path: 'limit', message: 'limit must not be greater than 100', code: 'max' }],
    });
    expect(toProblemDetails(structured, ctx)).toMatchObject({
      code: 'VALIDATION_FAILED',
      detail: 'Request validation failed',
      errors: [{ path: 'limit', code: 'max' }],
    });
  });

  it('maps a plain 400 string message to BAD_REQUEST', () => {
    expect(
      toProblemDetails(new BadRequestException('Validation failed (uuid is expected)'), ctx),
    ).toMatchObject({
      status: 400,
      code: 'BAD_REQUEST',
      detail: 'Validation failed (uuid is expected)',
    });
  });

  it('maps a throttler 429 to RATE_LIMITED with a friendly detail', () => {
    const throttled = new HttpException(
      'ThrottlerException: Too Many Requests',
      HttpStatus.TOO_MANY_REQUESTS,
    );
    expect(toProblemDetails(throttled, ctx)).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      title: 'Too Many Requests',
      detail: 'Too many requests. Please retry later.',
    });
  });

  it('honours Nest 12 HttpException errorCode and NotFound', () => {
    const custom = new HttpException('Nope', 409, { errorCode: 'SEAT_TAKEN' });
    expect(toProblemDetails(custom, ctx)).toMatchObject({ code: 'SEAT_TAKEN', status: 409 });
    expect(toProblemDetails(new NotFoundException('Cannot GET /x'), ctx)).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      detail: 'Cannot GET /x',
    });
  });

  it('hides 5xx HttpException messages unless exposeInternal', () => {
    const exception = new InternalServerErrorException('db password is hunter2');
    expect(toProblemDetails(exception, ctx).detail).toBeUndefined();
    expect(toProblemDetails(exception, { ...ctx, exposeInternal: true }).detail).toBe(
      'db password is hunter2',
    );
    expect(toProblemDetails(new BadGatewayException(), ctx)).toMatchObject({
      status: 502,
      code: 'EXTERNAL_SERVICE_ERROR',
    });
  });

  it('maps Fastify-style errors carrying a 4xx statusCode', () => {
    const tooLarge = Object.assign(new Error('Request body is too large'), {
      statusCode: 413,
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    });
    expect(toProblemDetails(tooLarge, ctx)).toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      detail: 'Request body is too large',
    });
  });

  it('maps unknown errors to a 500 with the message hidden unless exposeInternal', () => {
    const problem = toProblemDetails(new TypeError('x is undefined'), ctx);
    expect(problem).toEqual({
      type: 'https://errors.nestjs-boilerplate.dev/internal',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred.',
      instance: '/v1/users',
      code: 'INTERNAL',
      requestId: 'req-1',
    });
    expect(
      toProblemDetails(new TypeError('x is undefined'), { ...ctx, exposeInternal: true }).detail,
    ).toBe('x is undefined');
    expect(toProblemDetails('a thrown string', { exposeInternal: false })).toMatchObject({
      status: 500,
      code: 'INTERNAL',
    });
  });

  it('never emits a `statusCode` member and honours a custom type base URL', () => {
    const problem = toProblemDetails(new DomainConflictException(), {
      exposeInternal: false,
      typeBaseUrl: 'https://example.com/problems/',
    });
    expect(problem).not.toHaveProperty('statusCode');
    expect(problem.type).toBe('https://example.com/problems/conflict');
    expect(problem).not.toHaveProperty('requestId');
    expect(problem).not.toHaveProperty('instance');
  });
});
