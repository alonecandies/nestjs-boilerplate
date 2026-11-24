import { Metadata } from '@grpc/grpc-js';
import { Logger } from '@nestjs/common';
import { GrpcStatus } from '@nestjs/microservices';
import { register } from 'prom-client';
import { GrpcCircuitBreakers } from './grpc-circuit-breakers.js';

const serviceError = (code: GrpcStatus): Error =>
  Object.assign(new Error(`${code} ${GrpcStatus[code]}`), {
    code,
    details: 'upstream',
    metadata: new Metadata(),
  });

async function events(upstream: string): Promise<Record<string, number>> {
  const metric = register.getSingleMetric('grpc_client_circuit_breaker_events_total');
  if (metric === undefined) return {};
  const { values } = await metric.get();
  return Object.fromEntries(
    values
      .filter((sample) => sample.labels['upstream'] === upstream)
      .map((sample) => [String(sample.labels['event']), sample.value]),
  );
}

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

describe('grpc_client_circuit_breaker_events_total', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  // A breaker is created by its first call, so `increase()` sees its first event only when a
  // scrape saw the zero first: the three series exist from creation on.
  it('exposes success, failure and reject at 0 when a breaker is created', async () => {
    const breakers = new GrpcCircuitBreakers();
    breakers.get('events-new');
    expect(await events('events-new')).toEqual({ success: 0, failure: 0, reject: 0 });
    breakers.onApplicationShutdown();
  });

  it('counts a rejected call, a failed call and a filtered caller error', async () => {
    const breakers = new GrpcCircuitBreakers();
    const breaker = breakers.get('events-count');

    // A caller error from a healthy upstream: the errorFilter turns it into `success`.
    await expect(
      breaker.fire(() => Promise.reject(serviceError(GrpcStatus.NOT_FOUND))),
    ).rejects.toMatchObject({ code: GrpcStatus.NOT_FOUND });
    expect(await events('events-count')).toEqual({ success: 1, failure: 0, reject: 0 });

    await expect(
      breaker.fire(() => Promise.reject(serviceError(GrpcStatus.UNAVAILABLE))),
    ).rejects.toMatchObject({ code: GrpcStatus.UNAVAILABLE });
    expect(await events('events-count')).toEqual({ success: 1, failure: 1, reject: 0 });

    breaker.open();
    await expect(breaker.fire(() => Promise.resolve('never sent'))).rejects.toMatchObject({
      code: 'EOPENBREAKER',
    });
    expect(await events('events-count')).toEqual({ success: 1, failure: 1, reject: 1 });

    breakers.onApplicationShutdown();
  });

  it('keeps counting across registries that share an upstream name', async () => {
    const a = new GrpcCircuitBreakers();
    await a.get('events-shared').fire(() => Promise.resolve('ok'));
    const b = new GrpcCircuitBreakers();
    b.get('events-shared');
    expect(await events('events-shared')).toEqual({ success: 1, failure: 0, reject: 0 });
    a.onApplicationShutdown();
    b.onApplicationShutdown();
  });
});
