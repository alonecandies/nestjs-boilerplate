import { describe, expect, it } from 'vitest';
import { collectClusterMetrics, enableClusterMetricsWorker } from './cluster-metrics.js';

describe('cluster metrics outside a cluster', () => {
  it('enableClusterMetricsWorker is a no-op outside workers', () => {
    expect(() => enableClusterMetricsWorker()).not.toThrow();
  });

  it('collectClusterMetrics resolves the (empty) aggregate when the primary has no workers', async () => {
    await expect(collectClusterMetrics()).resolves.toEqual(expect.any(String));
  });
});
