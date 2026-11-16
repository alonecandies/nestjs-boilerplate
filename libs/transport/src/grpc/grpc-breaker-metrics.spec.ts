import { register } from 'prom-client';
import { GrpcCircuitBreakers } from './grpc-circuit-breakers.js';

async function states(upstream: string): Promise<Record<string, number>> {
  const metric = register.getSingleMetric('grpc_client_circuit_breaker_state');
  if (metric === undefined) return {};
  const { values } = await metric.get();
  return Object.fromEntries(
    values
      .filter((sample) => sample.labels['upstream'] === upstream)
      .map((sample) => [String(sample.labels['state']), sample.value]),
  );
}

describe('grpc_client_circuit_breaker_state', () => {
  it('exposes each upstream one-hot and forgets it on shutdown', async () => {
    const breakers = new GrpcCircuitBreakers();
    const breaker = breakers.get('orders-gauge');
    expect(await states('orders-gauge')).toEqual({ closed: 1, half_open: 0, open: 0 });
    breaker.open();
    expect(await states('orders-gauge')).toEqual({ closed: 0, half_open: 0, open: 1 });
    breakers.onApplicationShutdown();
    expect(await states('orders-gauge')).toEqual({});
  });

  it('merges the breakers of several GrpcClientsModule registrations', async () => {
    const a = new GrpcCircuitBreakers();
    const b = new GrpcCircuitBreakers();
    a.get('upstream-a');
    b.get('upstream-b');
    expect(await states('upstream-a')).toMatchObject({ closed: 1 });
    expect(await states('upstream-b')).toMatchObject({ closed: 1 });
    a.onApplicationShutdown();
    b.onApplicationShutdown();
  });
});
