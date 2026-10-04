import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { PROBLEM_JSON_CONTENT_TYPE } from '../constants/headers.constants.js';
import { isUuidV7 } from '../utils/id.util.js';
import { CorrelationIdMiddleware } from './correlation-id.middleware.js';
import { MaintenanceModeMiddleware } from './maintenance-mode.middleware.js';
import type { RawRequest } from './raw-http.types.js';

function rawRequest(
  init: Partial<RawRequest> & { headers?: RawRequest['headers'] } = {},
): RawRequest {
  return { headers: {}, url: '/', ...init } as RawRequest;
}

function rawResponse() {
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader: vi.fn((name: string, value: string) => headers.set(name, value)),
    end: vi.fn(),
  };
  return { res: res as unknown as ServerResponse & typeof res, headers };
}

describe('CorrelationIdMiddleware', () => {
  const middleware = new CorrelationIdMiddleware();

  it('uses the Fastify request id and defaults the correlation id to it', () => {
    const req = rawRequest({ id: 'req-1' });
    const { res, headers } = rawResponse();
    const next = vi.fn();
    middleware.use(req, res, next);
    expect(headers.get('x-request-id')).toBe('req-1');
    expect(headers.get('x-correlation-id')).toBe('req-1');
    expect(req.headers['x-correlation-id']).toBe('req-1');
    expect(next).toHaveBeenCalledOnce();
  });

  it('propagates a valid incoming correlation id', () => {
    const req = rawRequest({ id: 'req-2', headers: { 'x-correlation-id': 'chain-7' } });
    const { res, headers } = rawResponse();
    middleware.use(req, res, vi.fn());
    expect(headers.get('x-correlation-id')).toBe('chain-7');
  });

  it('replaces unsafe incoming ids and generates one when the platform has none', () => {
    const req = rawRequest({
      headers: { 'x-request-id': 'bad id\r\n', 'x-correlation-id': 'x'.repeat(500) },
    });
    const { res, headers } = rawResponse();
    middleware.use(req, res, vi.fn());
    const requestId = headers.get('x-request-id');
    expect(isUuidV7(requestId)).toBe(true);
    expect(headers.get('x-correlation-id')).toBe(requestId);
    expect(req.id).toBe(requestId);
  });
});

describe('MaintenanceModeMiddleware', () => {
  it('is transparent when maintenance mode is off (default)', () => {
    const next = vi.fn();
    const { res } = rawResponse();
    new MaintenanceModeMiddleware().use(rawRequest({ originalUrl: '/v1/users' }), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('answers 503 problem+json with Retry-After when on', () => {
    const next = vi.fn();
    const { res, headers } = rawResponse();
    new MaintenanceModeMiddleware(true).use(
      rawRequest({ id: 'r-1', originalUrl: '/v1/users?x=1' }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(headers.get('content-type')).toBe(PROBLEM_JSON_CONTENT_TYPE);
    expect(headers.get('retry-after')).toBe('120');
    expect(JSON.parse(res.end.mock.calls[0]?.[0] as string)).toMatchObject({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      instance: '/v1/users',
      requestId: 'r-1',
    });
  });

  it.each(['/health', '/health/ready', '/metrics'])(
    'lets %s through during maintenance',
    (path) => {
      const next = vi.fn();
      const { res } = rawResponse();
      new MaintenanceModeMiddleware(true).use(rawRequest({ originalUrl: path }), res, next);
      expect(next).toHaveBeenCalledOnce();
    },
  );

  it('supports runtime toggles and custom options', () => {
    let on = false;
    const middleware = new MaintenanceModeMiddleware(() => on, {
      retryAfterSec: 30,
      bypassPaths: ['/status'],
    });
    const first = rawResponse();
    const next = vi.fn();
    middleware.use(rawRequest({ originalUrl: '/v1/x' }), first.res, next);
    expect(next).toHaveBeenCalledOnce();

    on = true;
    const second = rawResponse();
    middleware.use(rawRequest({ originalUrl: '/v1/x' }), second.res, vi.fn());
    expect(second.headers.get('retry-after')).toBe('30');

    const bypass = vi.fn();
    middleware.use(rawRequest({ originalUrl: '/status' }), rawResponse().res, bypass);
    expect(bypass).toHaveBeenCalledOnce();
  });
});
