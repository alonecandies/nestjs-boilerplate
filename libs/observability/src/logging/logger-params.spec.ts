import { appConfig, observabilityConfig } from '@app/config';
import { INVALID_SPAN_CONTEXT, trace } from '@opentelemetry/api';
import type { Options as PinoHttpOptions } from 'pino-http';
import { describe, expect, it, vi } from 'vitest';
import { buildLoggerParams, LOG_REDACT_PATHS, traceContextMixin } from './logger-params.js';
import { rpcErrorObject, rpcLogLevel } from './rpc-error-logging.js';

const env = { NODE_ENV: 'production', SERVICE_NAME: 'orders', LOG_LEVEL: 'warn' };

function pinoHttpOptions(extraEnv: Record<string, string> = {}): PinoHttpOptions {
  const merged = { ...env, ...extraEnv };
  const params = buildLoggerParams(observabilityConfig.parse(merged), appConfig.parse(merged), {
    sync: true,
  });
  return params.pinoHttp as PinoHttpOptions;
}

describe('buildLoggerParams', () => {
  it('logs JSON with a string level label, the service name and the request id key', () => {
    const options = pinoHttpOptions();
    expect(options.level).toBe('warn');
    expect(options.base).toMatchObject({ service: 'orders' });
    expect(options.customAttributeKeys).toEqual({ reqId: 'requestId' });
    expect(options.formatters?.level?.('info', 30)).toEqual({ level: 'info' });
    expect(options.transport).toBeUndefined();
  });

  it('redacts credentials and never auto-logs probes or scrapes', () => {
    const options = pinoHttpOptions();
    expect(options.redact).toEqual({ paths: [...LOG_REDACT_PATHS], censor: '[REDACTED]' });
    expect(LOG_REDACT_PATHS).toEqual(
      expect.arrayContaining(['req.headers.authorization', '*.password', '*.refreshToken']),
    );
    const autoLogging = options.autoLogging as { ignore: (req: { url: string }) => boolean };
    expect(autoLogging.ignore({ url: '/health/ready' })).toBe(true);
    expect(autoLogging.ignore({ url: '/metrics' })).toBe(true);
    expect(autoLogging.ignore({ url: '/v1/users?x=1' })).toBe(false);
  });

  it('serializes requests without headers or query string', () => {
    const serializers = pinoHttpOptions().serializers as Record<
      string,
      (value: unknown) => unknown
    >;
    expect(
      serializers['req']?.({ id: 'r1', method: 'GET', url: '/v1/files?token=secret', headers: {} }),
    ).toEqual({ id: 'r1', method: 'GET', url: '/v1/files', remoteAddress: undefined });
  });

  it('maps response status to log level', () => {
    const customLogLevel = pinoHttpOptions().customLogLevel as (
      req: unknown,
      res: { statusCode: number },
      err?: Error,
    ) => string;
    expect(customLogLevel({}, { statusCode: 200 })).toBe('info');
    expect(customLogLevel({}, { statusCode: 404 })).toBe('warn');
    expect(customLogLevel({}, { statusCode: 503 })).toBe('error');
    expect(customLogLevel({}, { statusCode: 200 }, new Error('boom'))).toBe('error');
  });

  it('gives gRPC/Kafka handlers their own log context', () => {
    const params = buildLoggerParams(observabilityConfig.parse(env), appConfig.parse(env));
    expect(params.microservice).toMatchObject({
      includePayload: false,
      quietRpcLogger: true,
      customLogLevel: rpcLogLevel,
      customErrorObject: rpcErrorObject,
    });
  });
});

describe('traceContextMixin', () => {
  it('is empty without an active span', () => {
    expect(traceContextMixin()).toEqual({});
  });

  it('is empty for an invalid (non-sampled placeholder) span context', () => {
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(trace.wrapSpanContext(INVALID_SPAN_CONTEXT));
    expect(traceContextMixin()).toEqual({});
  });

  it('adds trace_id/span_id/trace_flags of the active span', () => {
    const spanContext = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
    };
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(trace.wrapSpanContext(spanContext));
    expect(traceContextMixin()).toEqual({
      trace_id: spanContext.traceId,
      span_id: spanContext.spanId,
      trace_flags: '01',
    });
  });
});
