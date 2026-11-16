import { observabilityConfig } from './observability.config.js';

const parse = (env: Record<string, string> = {}) =>
  observabilityConfig.parse({ SERVICE_NAME: 'svc', ...env });

describe('observability namespace: METRICS_PORT', () => {
  it('defaults to 9464 (the OpenTelemetry Prometheus exporter port)', () => {
    expect(parse().metricsPort).toBe(9464);
  });

  it('accepts 0 (OS-picked, tests) and any TCP port', () => {
    expect(parse({ METRICS_PORT: '0' }).metricsPort).toBe(0);
    expect(parse({ METRICS_PORT: '9467' }).metricsPort).toBe(9467);
  });

  it('rejects a value outside 0..65535', () => {
    expect(() => parse({ METRICS_PORT: '70000' })).toThrow();
  });
});
