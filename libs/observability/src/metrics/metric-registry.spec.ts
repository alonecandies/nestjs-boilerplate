import { Counter, register } from 'prom-client';
import { getOrCreateCounter, getOrCreateGauge, getOrCreateHistogram } from './metric-registry.js';

describe('getOrCreate* (process-wide metrics outside DI)', () => {
  it('returns the already registered metric instead of throwing a duplicate', () => {
    const first = getOrCreateCounter({ name: 'test_registry_total', help: 'h', labelNames: ['a'] });
    const second = getOrCreateCounter({
      name: 'test_registry_total',
      help: 'h',
      labelNames: ['a'],
    });
    expect(second).toBe(first);
    expect(first).toBeInstanceOf(Counter);
    expect(register.getSingleMetric('test_registry_total')).toBe(first);
  });

  it('throws when the name is taken by another metric type', () => {
    getOrCreateGauge({ name: 'test_registry_gauge', help: 'h' });
    expect(() => getOrCreateHistogram({ name: 'test_registry_gauge', help: 'h' })).toThrow(
      'test_registry_gauge is already registered as another metric type',
    );
  });
});
