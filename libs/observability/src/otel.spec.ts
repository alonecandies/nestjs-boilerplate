import { describe, expect, it } from 'vitest';
import { isTracingActive, isTracingEnabled, shutdownTracing, startTracing } from './otel.js';

describe('isTracingEnabled', () => {
  it.each([
    [{}, false],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }, true],
    [{ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/v1/traces' }, true],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' }, false],
    [{ OTEL_SDK_DISABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }, false],
    [{ OTEL_SDK_DISABLED: 'false' }, true],
    [{ OTEL_SDK_DISABLED: '1' }, false],
    [{ OTEL_SDK_DISABLED: 'maybe', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }, true],
  ])('%j → %s (mirrors observabilityConfig.tracingEnabled)', (env, expected) => {
    expect(isTracingEnabled(env)).toBe(expected);
  });
});

describe('startTracing / shutdownTracing', () => {
  it('is a no-op when tracing is disabled (no hook, no SDK)', async () => {
    await startTracing({ serviceName: 'test', env: { OTEL_SDK_DISABLED: 'true' } });
    expect(isTracingActive()).toBe(false);
  });

  it('shutdown is safe when tracing never started, and idempotent', async () => {
    await expect(shutdownTracing()).resolves.toBeUndefined();
    await expect(shutdownTracing()).resolves.toBeUndefined();
  });
});
