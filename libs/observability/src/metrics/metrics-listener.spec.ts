import type { AppConfig, ObservabilityConfig } from '@platform/config';
import { MetricsListener } from './metrics-listener.js';

const observability = (overrides: Partial<ObservabilityConfig> = {}) =>
  ({
    metricsEnabled: true,
    metricsPort: 0,
    metricsBearerToken: undefined,
    ...overrides,
  }) as ObservabilityConfig;
const app = (overrides: Partial<AppConfig> = {}) =>
  ({ port: 3000, host: '127.0.0.1', ...overrides }) as AppConfig;

describe('MetricsListener', () => {
  it('stays closed when METRICS_ENABLED=false, and scrape() answers 404', async () => {
    const listener = new MetricsListener(observability({ metricsEnabled: false }), app());
    await expect(listener.start()).resolves.toBeUndefined();
    expect((await listener.scrape()).status).toBe(404);
  });

  it('refuses METRICS_PORT equal to PORT', async () => {
    const listener = new MetricsListener(observability({ metricsPort: 3000 }), app({ port: 3000 }));
    await expect(listener.start()).rejects.toThrow(
      'METRICS_PORT (3000) must differ from PORT (3000)',
    );
  });

  // Binds 127.0.0.1: run with the sandbox off.
  it('opens once, serves the default registry and closes on shutdown', async () => {
    const listener = new MetricsListener(observability(), app());
    const url = (await listener.start()) ?? '';
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(listener.start()).resolves.toBe(url);
    expect((await listener.scrape()).status).toBe(200);
    await listener.onApplicationShutdown();
    await expect(fetch(`${url}/metrics`)).rejects.toThrow();
  });

  it('rejects when the port is taken', async () => {
    const first = new MetricsListener(observability(), app());
    const url = (await first.start()) ?? '';
    try {
      const port = Number(new URL(url).port);
      const second = new MetricsListener(observability({ metricsPort: port }), app());
      await expect(second.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await first.onApplicationShutdown();
    }
  });
});
