import { HttpException, Logger, NotFoundException } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { lastValueFrom, type Observable } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROBLEM_JSON_CONTENT_TYPE } from '../constants/headers.constants.js';
import { DomainConflictException } from '../errors/domain.exception.js';
import type { ProblemDetails } from '../errors/problem-details.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

/** Minimal stand-in for Nest's FastifyAdapter: records what the filter asks it to send. */
function fakeAdapterHost() {
  const adapter = {
    getRequestUrl: vi.fn((req: { url: string }) => req.url),
    isHeadersSent: vi.fn(() => false),
    setHeader: vi.fn(),
    reply: vi.fn(),
  };
  return { host: { httpAdapter: adapter } as unknown as HttpAdapterHost, adapter };
}

function httpHost(request: object, response: object): ExecutionContextHost {
  const host = new ExecutionContextHost([request, response, vi.fn()]);
  host.setType('http');
  return host;
}

const fastifyReply = () => ({ status: vi.fn(), sent: false });

/*
 * Structural stand-ins for @platform/database's errors (@platform/common cannot import it): the
 * mapping keys on `name` and `code`. libs/database/src/errors.problem-details.spec.ts runs the same
 * mapping over the real classes.
 */
class RlsContextError extends Error {
  override readonly name = 'RlsContextError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
class SystemDatabaseError extends Error {
  override readonly name = 'SystemDatabaseError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
class RowCountMismatchError extends Error {
  override readonly name = 'RowCountMismatchError';
}

describe('AllExceptionsFilter', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    debugSpy = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  describe('http', () => {
    describe('database errors become stable codes, never their internal messages', () => {
      const reply = (exception: unknown) => {
        const { host, adapter } = fakeAdapterHost();
        const request = { id: 'req-db', url: '/v1/things', method: 'GET', headers: {} };
        new AllExceptionsFilter(host).catch(exception, httpHost(request, fastifyReply()));
        const [, body, status] = adapter.reply.mock.calls[0] as [object, ProblemDetails, number];
        return { body, status };
      };

      it.each([
        [
          'RLS_NO_PRINCIPAL → 401 UNAUTHENTICATED',
          new RlsContextError('RLS_NO_PRINCIPAL', 'RLS context: no principal in CLS'),
          401,
          'UNAUTHENTICATED',
        ],
        [
          'RLS_PLATFORM_TENANT → 403 FORBIDDEN',
          new RlsContextError('RLS_PLATFORM_TENANT', 'RLS context: the platform tenant 0000…'),
          403,
          'FORBIDDEN',
        ],
        [
          'RowCountMismatchError → 409 CONFLICT',
          new RowCountMismatchError('users.updatePasswordHash: expected 1 row(s) affected, got 0'),
          409,
          'CONFLICT',
        ],
        [
          'SYSTEM_DATABASE_UNAVAILABLE → 503',
          new SystemDatabaseError(
            'SYSTEM_DATABASE_UNAVAILABLE',
            'System method users.findCredentialsByEmail: no system pool (set DATABASE_SYSTEM_URL)',
          ),
          503,
          'SYSTEM_DATABASE_UNAVAILABLE',
        ],
      ])('%s', (_name, exception, status, code) => {
        const problem = reply(exception);
        expect(problem.status).toBe(status);
        expect(problem.body).toMatchObject({ status, code });
        const text = JSON.stringify(problem.body);
        for (const internal of ['RLS context', 'users.', 'DATABASE_SYSTEM_URL', 'row(s)', '0000']) {
          expect(text, internal).not.toContain(internal);
        }
        // 4xx are client outcomes (debug); the 503 is an incident, logged with the original error.
        if (status >= 500) {
          expect(errorSpy).toHaveBeenCalledWith(
            expect.objectContaining({ err: exception }),
            expect.any(String),
          );
        } else {
          expect(errorSpy).not.toHaveBeenCalled();
        }
      });

      it.each([
        ['RLS_CONTEXT_STALE', new RlsContextError('RLS_CONTEXT_STALE', 'RLS context: stale')],
        ['RLS_NO_TRANSACTION', new RlsContextError('RLS_NO_TRANSACTION', 'RLS: no transaction')],
        [
          'SYSTEM_CONTEXT_REQUIRED',
          new SystemDatabaseError('SYSTEM_CONTEXT_REQUIRED', 'System method x outside context'),
        ],
      ])('%s stays a 500 INTERNAL (a programming error), message hidden', (_name, exception) => {
        const problem = reply(exception);
        expect(problem.body).toMatchObject({ status: 500, code: 'INTERNAL' });
        expect(JSON.stringify(problem.body)).not.toContain(exception.message);
      });

      it('a look-alike that is not an Error is not translated', () => {
        const problem = reply({ name: 'RlsContextError', code: 'RLS_NO_PRINCIPAL' });
        expect(problem.body).toMatchObject({ status: 500, code: 'INTERNAL' });
      });
    });

    it('replies problem+json through the adapter (Fastify reply)', () => {
      const { host, adapter } = fakeAdapterHost();
      const filter = new AllExceptionsFilter(host);
      const request = { id: 'req-9', url: '/v1/users/1?token=secret', method: 'GET', headers: {} };
      const reply = fastifyReply();

      filter.catch(
        new DomainConflictException('Email already registered'),
        httpHost(request, reply),
      );

      expect(adapter.setHeader).toHaveBeenCalledWith(
        reply,
        'content-type',
        PROBLEM_JSON_CONTENT_TYPE,
      );
      expect(adapter.reply).toHaveBeenCalledTimes(1);
      const [target, body, status] = adapter.reply.mock.calls[0] as [
        object,
        ProblemDetails,
        number,
      ];
      expect(target).toBe(reply);
      expect(status).toBe(409);
      expect(body).toEqual({
        type: 'https://errors.nestjs-boilerplate.dev/conflict',
        title: 'Conflict',
        status: 409,
        detail: 'Email already registered',
        instance: '/v1/users/1',
        code: 'CONFLICT',
        requestId: 'req-9',
      });
      expect(debugSpy).toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('does not log requestId itself (the request-scoped pino logger binds it: no duplicate key)', () => {
      const { host } = fakeAdapterHost();
      const filter = new AllExceptionsFilter(host);
      const request = { id: 'req-7', url: '/v1/catalog/shipments', method: 'GET', headers: {} };

      filter.catch(new Error('upstream down'), httpHost(request, fastifyReply()));
      filter.catch(new NotFoundException(), httpHost(request, fastifyReply()));

      const errorFields = errorSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      const debugFields = debugSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      for (const fields of [errorFields, debugFields]) {
        expect(fields).toMatchObject({ method: 'GET', path: '/v1/catalog/shipments' });
        expect(fields).not.toHaveProperty('requestId');
      }
    });

    it('falls back to the x-request-id header and hides internals by default', () => {
      const { host, adapter } = fakeAdapterHost();
      const filter = new AllExceptionsFilter(host);
      const request = { url: '/v1/boom', method: 'POST', headers: { 'x-request-id': 'hdr-1' } };

      filter.catch(new Error('connection string leaked'), httpHost(request, fastifyReply()));

      const body = adapter.reply.mock.calls[0]?.[1] as ProblemDetails;
      expect(body).toMatchObject({ status: 500, code: 'INTERNAL', requestId: 'hdr-1' });
      expect(body.detail).toBe('An unexpected error occurred.');
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('exposes internal messages when configured (non-production)', () => {
      const { host, adapter } = fakeAdapterHost();
      const filter = new AllExceptionsFilter(host, { exposeInternal: true });
      filter.catch(new Error('stack me'), httpHost({ url: '/x', headers: {} }, fastifyReply()));
      const body = adapter.reply.mock.calls[0]?.[1] as ProblemDetails | undefined;
      expect(body?.detail).toBe('stack me');
    });

    it('does nothing when headers were already sent', () => {
      const { host, adapter } = fakeAdapterHost();
      adapter.isHeadersSent.mockReturnValue(true);
      new AllExceptionsFilter(host).catch(
        new NotFoundException(),
        httpHost({ url: '/x', headers: {} }, fastifyReply()),
      );
      expect(adapter.reply).not.toHaveBeenCalled();
    });

    it('writes directly to a raw Node response (errors thrown in Fastify middleware)', () => {
      const { host, adapter } = fakeAdapterHost();
      const raw = { headersSent: false, statusCode: 200, setHeader: vi.fn(), end: vi.fn() };

      new AllExceptionsFilter(host).catch(
        new NotFoundException('Cannot GET /nope'),
        httpHost({ id: 'r1', url: '/nope', headers: {} }, raw),
      );

      expect(adapter.reply).not.toHaveBeenCalled();
      expect(raw.statusCode).toBe(404);
      expect(raw.setHeader).toHaveBeenCalledWith('content-type', PROBLEM_JSON_CONTENT_TYPE);
      expect(JSON.parse(raw.end.mock.calls[0]?.[0] as string)).toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
        requestId: 'r1',
      });
    });
  });

  it('graphql: returns the exception untouched for Apollo to format', () => {
    const host = new ExecutionContextHost([{}, {}, { req: {} }, {}]);
    host.setType('graphql');
    const error = new DomainConflictException();
    expect(new AllExceptionsFilter(fakeAdapterHost().host).catch(error, host)).toBe(error);
  });

  it('ws: emits an `exception` event with the problem document', () => {
    const client = { emit: vi.fn() };
    const host = new ExecutionContextHost([client, { id: 1 }, undefined, 'alerts.markRead']);
    host.setType('ws');

    new AllExceptionsFilter(fakeAdapterHost().host).catch(new DomainConflictException(), host);

    expect(client.emit).toHaveBeenCalledWith(
      'exception',
      expect.objectContaining({
        status: 409,
        code: 'CONFLICT',
        instance: 'alerts.markRead',
      }),
    );
  });

  it('ws: answers through the ack callback when the client used one', () => {
    const client = { emit: vi.fn() };
    const ack = vi.fn();
    const host = new ExecutionContextHost([client, {}, ack, 'ping']);
    host.setType('ws');

    new AllExceptionsFilter(fakeAdapterHost().host).catch(new DomainConflictException(), host);

    expect(ack).toHaveBeenCalledWith({
      ok: false,
      error: expect.objectContaining({ code: 'CONFLICT' }),
    });
    expect(client.emit).not.toHaveBeenCalled();
  });

  it('ws: a throttled message is acked as { ok: false, error: 429 RATE_LIMITED }', () => {
    const ack = vi.fn();
    const host = new ExecutionContextHost([{ emit: vi.fn() }, {}, ack, 'alerts.markRead']);
    host.setType('ws');
    new AllExceptionsFilter(fakeAdapterHost().host).catch(
      new HttpException('ThrottlerException: Too Many Requests', 429),
      host,
    );
    expect(ack).toHaveBeenCalledWith({
      ok: false,
      error: expect.objectContaining({
        status: 429,
        code: 'RATE_LIMITED',
        detail: 'Too many requests. Please retry later.',
      }),
    });
  });

  it('rpc: rethrows as an observable error for controller-scoped filters', async () => {
    const host = new ExecutionContextHost([{}, {}]);
    host.setType('rpc');
    const error = new DomainConflictException();
    const result = new AllExceptionsFilter(fakeAdapterHost().host).catch(
      error,
      host,
    ) as Observable<never>;
    await expect(lastValueFrom(result)).rejects.toBe(error);
  });
});
