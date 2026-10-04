import type { IncomingHttpHeaders } from 'node:http';
import { HTTP_HEADERS, isUuidV7 } from '@app/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { describe, expect, it } from 'vitest';
import {
  incomingCorrelationId,
  requestIdOf,
  resolveContextRequestId,
  resolveRequestId,
  resolveRpcRequestId,
} from './request-id.js';

const carrier = (headers: IncomingHttpHeaders = {}): { headers: IncomingHttpHeaders } => ({
  headers,
});

function rpcContext(rpcCtx: unknown): ExecutionContextHost {
  const ctx = new ExecutionContextHost([{ payload: true }, rpcCtx]);
  ctx.setType('rpc');
  return ctx;
}

/** Structural stand-ins: this package depends on neither @nestjs/microservices nor grpc-js. */
const kafkaContext = (headers: Record<string, unknown>) => ({
  getMessage: () => ({ headers }),
});
const grpcMetadata = (entries: Record<string, (string | Buffer)[]>) => ({
  get: (key: string) => entries[key] ?? [],
});

describe('resolveRequestId', () => {
  it('adopts a valid incoming x-request-id', () => {
    const req = carrier({ [HTTP_HEADERS.REQUEST_ID]: 'abc-123.def:456_X' });
    expect(resolveRequestId(req)).toBe('abc-123.def:456_X');
  });

  it.each([
    ['too long', 'a'.repeat(129)],
    ['forbidden characters', 'abc 123'],
    ['header injection attempt', 'abc\r\nx-evil: 1'],
    ['empty', ''],
  ])('replaces an invalid incoming id (%s) with a UUIDv7', (_label, incoming) => {
    const req = carrier({ [HTTP_HEADERS.REQUEST_ID]: incoming });
    expect(isUuidV7(resolveRequestId(req))).toBe(true);
  });

  it('writes a generated id back so later callers (pino-http, cls) converge on it', () => {
    const req = carrier();
    const first = resolveRequestId(req);
    expect(isUuidV7(first)).toBe(true);
    expect(req.headers[HTTP_HEADERS.REQUEST_ID]).toBe(first);
    expect(resolveRequestId(req)).toBe(first);
  });

  it('ignores a repeated (array) header', () => {
    const req = carrier({ [HTTP_HEADERS.REQUEST_ID]: ['a', 'b'] as unknown as string });
    expect(isUuidV7(resolveRequestId(req))).toBe(true);
  });
});

describe('requestIdOf', () => {
  it('reuses the id Fastify already assigned (req.id)', () => {
    expect(requestIdOf({ id: 'fastify-id', headers: {} })).toBe('fastify-id');
  });

  it('falls back to resolveRequestId when req.id is missing or unsafe', () => {
    expect(requestIdOf({ id: 42, headers: { [HTTP_HEADERS.REQUEST_ID]: 'hdr-1' } })).toBe('hdr-1');
  });
});

describe('incomingCorrelationId', () => {
  it('returns a valid x-correlation-id, else undefined', () => {
    expect(incomingCorrelationId(carrier({ [HTTP_HEADERS.CORRELATION_ID]: 'corr-1' }))).toBe(
      'corr-1',
    );
    expect(incomingCorrelationId(carrier({ [HTTP_HEADERS.CORRELATION_ID]: 'bad id' }))).toBe(
      undefined,
    );
    expect(incomingCorrelationId(carrier())).toBeUndefined();
  });
});

describe('resolveRpcRequestId', () => {
  it('reads x-request-id from Kafka message headers (Buffer values)', () => {
    const ctx = rpcContext(kafkaContext({ [HTTP_HEADERS.REQUEST_ID]: Buffer.from('kafka-req-1') }));
    expect(resolveRpcRequestId(ctx)).toBe('kafka-req-1');
  });

  it('reads x-request-id from gRPC metadata', () => {
    const ctx = rpcContext(grpcMetadata({ [HTTP_HEADERS.REQUEST_ID]: ['grpc-req-1'] }));
    expect(resolveRpcRequestId(ctx)).toBe('grpc-req-1');
  });

  it('falls back to x-correlation-id', () => {
    const ctx = rpcContext(grpcMetadata({ [HTTP_HEADERS.CORRELATION_ID]: ['corr-9'] }));
    expect(resolveRpcRequestId(ctx)).toBe('corr-9');
  });

  it('generates one id per message and returns it consistently for that message', () => {
    const message = kafkaContext({});
    const first = resolveRpcRequestId(rpcContext(message));
    expect(isUuidV7(first)).toBe(true);
    expect(resolveRpcRequestId(rpcContext(message))).toBe(first);
    expect(resolveRpcRequestId(rpcContext(kafkaContext({})))).not.toBe(first);
  });

  it('rejects unsafe ids from the wire', () => {
    const ctx = rpcContext(grpcMetadata({ [HTTP_HEADERS.REQUEST_ID]: ['x'.repeat(500)] }));
    expect(isUuidV7(resolveRpcRequestId(ctx))).toBe(true);
  });
});

describe('resolveContextRequestId', () => {
  it('uses the HTTP request id', () => {
    const ctx = new ExecutionContextHost([{ id: 'http-1', headers: {} }, {}]);
    expect(resolveContextRequestId(ctx)).toBe('http-1');
  });

  it('uses the header when the request has no id yet', () => {
    const ctx = new ExecutionContextHost([{ headers: { [HTTP_HEADERS.REQUEST_ID]: 'hdr-2' } }, {}]);
    expect(resolveContextRequestId(ctx)).toBe('hdr-2');
  });

  it('mints a fresh id per WebSocket message', () => {
    const ctx = new ExecutionContextHost([{}, {}]);
    ctx.setType('ws');
    const first = resolveContextRequestId(ctx);
    expect(isUuidV7(first)).toBe(true);
    expect(resolveContextRequestId(ctx)).not.toBe(first);
  });
});
