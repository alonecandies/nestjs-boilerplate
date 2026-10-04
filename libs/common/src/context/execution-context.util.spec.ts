import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { describe, expect, it } from 'vitest';
import {
  getContextType,
  getHeaderValue,
  getRequest,
  type RequestLike,
} from './execution-context.util.js';

function host(type: string, args: unknown[]): ExecutionContextHost {
  const ctx = new ExecutionContextHost(args);
  ctx.setType(type);
  return ctx;
}

describe('execution context utils', () => {
  it('reports the transport type, including graphql', () => {
    expect(getContextType(host('graphql', []))).toBe('graphql');
    expect(getContextType(host('rpc', []))).toBe('rpc');
  });

  it('http: returns the platform request', () => {
    const req = { headers: { a: '1' } };
    expect(getRequest(host('http', [req, {}]))).toBe(req);
  });

  it('graphql: returns context.req (third resolver argument)', () => {
    const req = { headers: {}, user: { id: 'u1' } };
    expect(getRequest(host('graphql', [{}, {}, { req }, {}]))).toBe(req);
    expect(getRequest(host('graphql', [{}, {}, undefined, {}]))).toBeUndefined();
  });

  it('ws: synthesizes a cached request bound to socket.data.user', () => {
    const socket: { id: string; handshake: object; data: { user?: unknown } } = {
      id: 'sock-1',
      handshake: { headers: { authorization: 'Bearer t' }, address: '10.0.0.1', url: '/socket.io' },
      data: {},
    };
    const ctx = host('ws', [socket, {}, undefined, 'ping']);
    const req = getRequest<RequestLike>(ctx);
    expect(req).toMatchObject({ id: 'sock-1', ip: '10.0.0.1', url: '/socket.io' });
    expect(req?.headers['authorization']).toBe('Bearer t');

    socket.data.user = { id: 'u1' };
    expect(req?.user).toEqual({ id: 'u1' });
    if (req) req.user = { id: 'u2' };
    expect(socket.data.user).toEqual({ id: 'u2' });
    expect(getRequest(ctx)).toBe(req);
  });

  it('rpc: has no request', () => {
    expect(getRequest(host('rpc', [{}, {}]))).toBeUndefined();
  });

  it('getHeaderValue returns the first non-empty value', () => {
    expect(getHeaderValue({ 'x-a': ['1', '2'] }, 'X-A')).toBe('1');
    expect(getHeaderValue({ 'x-a': '' }, 'x-a')).toBeUndefined();
    expect(getHeaderValue(undefined, 'x-a')).toBeUndefined();
  });
});
