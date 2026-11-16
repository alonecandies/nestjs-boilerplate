import { Metadata } from '@grpc/grpc-js';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { type Histogram, register } from 'prom-client';
import { lastValueFrom, NEVER, of, throwError } from 'rxjs';
import { grpcCall } from './grpc-call.js';
import { GrpcCircuitBreakers } from './grpc-circuit-breakers.js';
import { GrpcMetricsInterceptor } from './grpc-metrics.interceptor.js';
import { grpcClientCode, parseGrpcOperation } from './grpc-metrics.js';

async function value(name: string, labels: Record<string, string>): Promise<number> {
  const metric = register.getSingleMetric(name);
  if (metric === undefined) return 0;
  const { values } = await metric.get();
  const match = values.find((sample) =>
    Object.entries(labels).every(([key, label]) => sample.labels[key] === label),
  );
  return match?.value ?? 0;
}

const rpcContext = (path: string): ExecutionContext =>
  ({
    getType: () => 'rpc',
    switchToRpc: () => ({ getContext: () => new Metadata(), getData: () => ({}) }),
    getArgByIndex: (index: number) => (index === 2 ? { getPath: () => path } : undefined),
    getClass: () => class Svc {},
    getHandler: () => () => undefined,
  }) as unknown as ExecutionContext;

describe('gRPC metrics', () => {
  it('parses operations and grpc-js paths', () => {
    expect(parseGrpcOperation('orders.v1.OrdersService/GetOrder')).toEqual({
      service: 'orders.v1.OrdersService',
      method: 'GetOrder',
    });
    expect(parseGrpcOperation('/orders.v1.OrdersService/ListOrders')).toEqual({
      service: 'orders.v1.OrdersService',
      method: 'ListOrders',
    });
  });

  it('labels client failures', () => {
    expect(grpcClientCode(Object.assign(new Error('x'), { code: 'EOPENBREAKER' }))).toBe(
      'CIRCUIT_OPEN',
    );
    expect(grpcClientCode(new Error('x'))).toBe('UNKNOWN');
  });

  it('grpcCall counts successes, local deadlines and an open circuit', async () => {
    const labels = { grpc_service: 'test.v1.Svc', grpc_method: 'Get' };
    const ok = await value('grpc_client_handled_total', { ...labels, grpc_code: 'OK' });
    await grpcCall(of(1), { timeoutMs: 1_000, operation: 'test.v1.Svc/Get' });
    expect(await value('grpc_client_handled_total', { ...labels, grpc_code: 'OK' })).toBe(ok + 1);

    await expect(grpcCall(NEVER, { timeoutMs: 5, operation: 'test.v1.Svc/Get' })).rejects.toThrow();
    expect(
      await value('grpc_client_handled_total', { ...labels, grpc_code: 'DEADLINE_EXCEEDED' }),
    ).toBeGreaterThan(0);

    const breakers = new GrpcCircuitBreakers();
    const breaker = breakers.get('test');
    breaker.open();
    await expect(
      grpcCall(of(1), { timeoutMs: 1_000, operation: 'test.v1.Svc/Get', breaker }),
    ).rejects.toThrow();
    expect(
      await value('grpc_client_handled_total', { ...labels, grpc_code: 'CIRCUIT_OPEN' }),
    ).toBeGreaterThan(0);
    breakers.onApplicationShutdown();
  });

  it('the server interceptor counts OK and failed calls with their status', async () => {
    const interceptor = new GrpcMetricsInterceptor();
    const labels = { grpc_service: 'test.v1.Server', grpc_method: 'Do' };
    const ok = await value('grpc_server_handled_total', { ...labels, grpc_code: 'OK' });
    const next: CallHandler = { handle: () => of('done') };
    await lastValueFrom(interceptor.intercept(rpcContext('/test.v1.Server/Do'), next));
    expect(await value('grpc_server_handled_total', { ...labels, grpc_code: 'OK' })).toBe(ok + 1);

    const failing: CallHandler = { handle: () => throwError(() => new Error('boom')) };
    await expect(
      lastValueFrom(interceptor.intercept(rpcContext('/test.v1.Server/Do'), failing)),
    ).rejects.toThrow('boom');
    expect(
      await value('grpc_server_handled_total', { ...labels, grpc_code: 'INTERNAL' }),
    ).toBeGreaterThan(0);
    const histogram = await (
      register.getSingleMetric('grpc_server_handling_seconds') as Histogram | undefined
    )?.get();
    const count = histogram?.values.find(
      (sample) =>
        sample.metricName === 'grpc_server_handling_seconds_count' &&
        sample.labels['grpc_service'] === 'test.v1.Server',
    );
    expect(count?.value).toBeGreaterThanOrEqual(2);
  });
});
