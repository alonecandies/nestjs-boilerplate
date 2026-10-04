import cluster from 'node:cluster';
import { describe, expect, it } from 'vitest';
import {
  enableClusterMetricsAggregation,
  enableClusterMetricsWorker,
  requestClusterMetrics,
} from './cluster-metrics.js';

describe('cluster metrics bridge (outside a cluster worker)', () => {
  it('runs in a primary process here', () => {
    expect(cluster.isWorker).toBe(false);
  });

  it('requestClusterMetrics resolves undefined so callers serve their local registry', async () => {
    enableClusterMetricsWorker(); // no-op outside workers
    await expect(requestClusterMetrics(10)).resolves.toBeUndefined();
  });

  it('enabling the primary aggregator is idempotent', () => {
    const before = cluster.listenerCount('message');
    enableClusterMetricsAggregation();
    const afterFirst = cluster.listenerCount('message');
    enableClusterMetricsAggregation();
    expect(afterFirst).toBeGreaterThan(before);
    expect(cluster.listenerCount('message')).toBe(afterFirst);
  });
});
