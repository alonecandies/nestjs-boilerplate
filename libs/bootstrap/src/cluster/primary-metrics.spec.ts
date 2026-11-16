import { startClusterPrimaryMetrics } from './primary-metrics.js';

describe('startClusterPrimaryMetrics', () => {
  it('opens nothing when METRICS_ENABLED=false', async () => {
    await expect(
      startClusterPrimaryMetrics({ SERVICE_NAME: 'svc', METRICS_ENABLED: 'false' }),
    ).resolves.toBeUndefined();
  });

  it('refuses METRICS_PORT equal to PORT before binding anything', async () => {
    await expect(
      startClusterPrimaryMetrics({ SERVICE_NAME: 'svc', PORT: '9464', METRICS_PORT: '9464' }),
    ).rejects.toThrow('METRICS_PORT (9464) must differ from PORT (9464)');
  });

  // Binds 127.0.0.1: run with the sandbox off.
  it('serves the (empty, no workers) cluster aggregate on METRICS_PORT', async () => {
    const server = await startClusterPrimaryMetrics({
      SERVICE_NAME: 'svc',
      METRICS_PORT: '0',
      HOST: '127.0.0.1',
    });
    if (server === undefined) throw new Error('expected a metrics server');
    try {
      expect((await fetch(`${server.url}/metrics`)).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
