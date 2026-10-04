import {
  DomainConflictException,
  DomainValidationException,
  EntityNotFoundException,
  ExternalServiceException,
  UnauthenticatedException,
} from '@app/common';
import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { isRpcClientError, rpcErrorObject, rpcLogLevel } from './rpc-error-logging.js';

class EmailTakenException extends DomainConflictException {
  override readonly code = 'EMAIL_TAKEN';
}

/** Mimics `RpcException` / `GrpcException` from `@nestjs/microservices` (`getError()` → `{ code }`). */
class FakeRpcException extends Error {
  constructor(private readonly error: unknown) {
    super('rpc');
  }

  getError(): unknown {
    return this.error;
  }
}

class FakeZodError extends Error {
  override readonly name = 'ZodError';
  readonly issues = [{ path: ['email'], message: 'Invalid email' }];
}

const value = { err: 'placeholder', responseTime: 3 };

describe('RPC auto-logging levels', () => {
  it.each([
    ['NOT_FOUND', new EntityNotFoundException('User', 'u1')],
    ['EMAIL_TAKEN', new EmailTakenException('Email already registered')],
    ['INVALID_CREDENTIALS', new UnauthenticatedException('Invalid credentials')],
    ['domain validation', new DomainValidationException()],
    ['ValidationPipe 400', new BadRequestException(['email must be an email'])],
    ['zod parse', new FakeZodError('invalid')],
    ['RpcException NOT_FOUND', new FakeRpcException({ code: 5, message: 'missing' })],
  ])('%s is a caller error → warn', (_name, error) => {
    expect(isRpcClientError(error)).toBe(true);
    expect(rpcLogLevel({}, error)).toBe('warn');
  });

  it.each([
    ['unexpected Error', new Error('db down')],
    ['upstream 502', new ExternalServiceException()],
    ['HTTP 500', new InternalServerErrorException()],
    ['RpcException INTERNAL', new FakeRpcException({ code: 13 })],
    ['bare RpcException', new FakeRpcException('boom')],
  ])('%s is a server-side failure → error', (_name, error) => {
    expect(isRpcClientError(error)).toBe(false);
    expect(rpcLogLevel({}, error)).toBe('error');
  });

  it('logs successful messages at info', () => {
    expect(rpcLogLevel({})).toBe('info');
  });

  it('drops the stack of caller errors but keeps type, message and code', () => {
    const error = new EmailTakenException('Email already registered');
    expect(rpcErrorObject({}, error, value)).toEqual({
      responseTime: 3,
      error: {
        type: 'EmailTakenException',
        message: 'Email already registered',
        code: 'EMAIL_TAKEN',
      },
    });
  });

  it('writes one stack-less warn line through the real pino serializers', () => {
    const lines: string[] = [];
    const logger = pino(
      { level: 'info', serializers: { err: pino.stdSerializers.err } },
      { write: (line: string) => lines.push(line) },
    );
    const error = new EmailTakenException('Email already registered');
    logger[rpcLogLevel({}, error)](
      rpcErrorObject({}, error, { err: error, responseTime: 3 }),
      'rpc errored',
    );
    const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(record).toMatchObject({
      level: 40,
      error: { type: 'EmailTakenException', code: 'EMAIL_TAKEN' },
    });
    expect(record).not.toHaveProperty('err');
    expect(lines[0]).not.toContain('"stack"');
  });

  it('keeps the full error object of server-side failures', () => {
    expect(rpcErrorObject({}, new Error('db down'), value)).toBe(value);
  });
});
