import {
  DomainValidationException,
  EntityNotFoundException,
  PermissionDeniedException,
} from '@app/common';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import { describe, expect, it } from 'vitest';
import { formatExecutionResult, formatGraphqlError } from './format-graphql-error.js';

/** What Apollo hands to `formatError` for an error thrown inside a resolver. */
function resolverError(original: unknown): {
  formatted: GraphQLFormattedError;
  error: GraphQLError;
} {
  const error = new GraphQLError(original instanceof Error ? original.message : 'x', {
    path: ['user'],
    originalError: original instanceof Error ? original : undefined,
  });
  const formatted: GraphQLFormattedError = {
    message: error.message,
    locations: [{ line: 1, column: 3 }],
    path: ['user'],
    extensions: {
      code: 'INTERNAL_SERVER_ERROR',
      stacktrace: ['Error: boom', '    at resolver (users.resolver.ts:1:1)'],
      originalError: { message: 'nest echo' },
    },
  };
  return { formatted, error };
}

const prod = formatGraphqlError({ exposeInternal: false });
const dev = formatGraphqlError({ exposeInternal: true });

describe('formatGraphqlError', () => {
  it('maps DomainExceptions to their code/status and keeps location + path', () => {
    const { formatted, error } = resolverError(new EntityNotFoundException('User', 'u1'));

    expect(prod(formatted, error)).toEqual({
      message: expect.stringContaining('User'),
      locations: [{ line: 1, column: 3 }],
      path: ['user'],
      extensions: {
        code: 'NOT_FOUND',
        status: 404,
        type: 'https://errors.nestjs-boilerplate.dev/not-found',
      },
    });
  });

  it('keeps domain-specific codes and exposes validation issues', () => {
    const exception = DomainValidationException.fromIssues(
      [{ path: ['email'], message: 'Invalid email', code: 'invalid_format' }],
      'Invalid input',
    );
    const { formatted, error } = resolverError(exception);

    const result = prod(formatted, error);

    expect(result.message).toBe('Invalid input');
    expect(result.extensions).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      errors: [{ path: 'email', message: 'Invalid email', code: 'invalid_format' }],
    });
  });

  it('maps HttpExceptions thrown by guards and pipes (401/403/400)', () => {
    const unauth = resolverError(new UnauthorizedException());
    const forbidden = resolverError(new PermissionDeniedException('Missing permission users:read'));
    const invalid = resolverError(
      new BadRequestException({
        message: 'Request validation failed',
        errors: [{ path: 'limit', message: 'limit must not be greater than 100' }],
      }),
    );

    expect(prod(unauth.formatted, unauth.error).extensions).toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
    expect(prod(forbidden.formatted, forbidden.error)).toMatchObject({
      message: 'Missing permission users:read',
      extensions: { code: 'FORBIDDEN', status: 403 },
    });
    expect(prod(invalid.formatted, invalid.error).extensions).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      errors: [{ path: 'limit', message: 'limit must not be greater than 100' }],
    });
  });

  it('hides unexpected errors and stack traces in production', () => {
    const { formatted, error } = resolverError(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

    const result = prod(formatted, error);

    expect(result.message).toBe('An unexpected error occurred.');
    expect(result.extensions).toEqual({
      code: 'INTERNAL',
      status: 500,
      type: 'https://errors.nestjs-boilerplate.dev/internal',
    });
    expect(JSON.stringify(result)).not.toContain('ECONNREFUSED');
  });

  it('reveals internals (message + stacktrace) outside production', () => {
    const { formatted, error } = resolverError(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

    const result = dev(formatted, error);

    expect(result.message).toBe('connect ECONNREFUSED 10.0.0.5:5432');
    expect(result.extensions?.['stacktrace']).toEqual(formatted.extensions?.['stacktrace']);
  });

  it('keeps GraphQL-level errors (validation, BAD_USER_INPUT, QUERY_TOO_COMPLEX) as Apollo made them', () => {
    const error = new GraphQLError('Cannot query field "nope" on type "Query".', {
      extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
    });
    const formatted: GraphQLFormattedError = {
      message: error.message,
      locations: [{ line: 1, column: 3 }],
      extensions: { code: 'GRAPHQL_VALIDATION_FAILED', stacktrace: ['GraphQLError: …'] },
    };

    expect(prod(formatted, error)).toEqual({
      message: error.message,
      locations: [{ line: 1, column: 3 }],
      extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
    });
    expect(dev(formatted, error)).toBe(formatted);
  });

  it('masks Apollo-level internal errors in production (e.g. context creation failures)', () => {
    const error = new GraphQLError('Context creation failed: redis timeout', {
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
    const formatted: GraphQLFormattedError = {
      message: error.message,
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    };

    expect(prod(formatted, error)).toEqual({
      message: 'An unexpected error occurred.',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });

  it('honours a custom problem type base URL', () => {
    const format = formatGraphqlError({ exposeInternal: false, typeBaseUrl: 'https://err.acme/' });
    const { formatted, error } = resolverError(new EntityNotFoundException('User', 'u1'));

    expect(format(formatted, error).extensions?.['type']).toBe('https://err.acme/not-found');
  });
});

describe('formatExecutionResult (graphql-ws onNext)', () => {
  it('formats subscription errors like HTTP ones and keeps data', () => {
    const error = new GraphQLError('db down: password=hunter2', {
      path: ['notificationCreated'],
      originalError: new Error('db down: password=hunter2'),
    });

    const result = formatExecutionResult({ data: null, errors: [error] }, prod);

    expect(result).toEqual({
      data: null,
      errors: [
        {
          message: 'An unexpected error occurred.',
          path: ['notificationCreated'],
          extensions: {
            code: 'INTERNAL',
            status: 500,
            type: 'https://errors.nestjs-boilerplate.dev/internal',
          },
        },
      ],
    });
  });

  it('returns undefined (send unchanged) when there are no errors', () => {
    expect(formatExecutionResult({ data: { ok: true } }, prod)).toBeUndefined();
    expect(formatExecutionResult({ data: { ok: true }, errors: [] }, prod)).toBeUndefined();
  });
});
