import {
  getOrCreateCounter,
  getOrCreateGauge,
  getOrCreateHistogram,
  HTTP_DURATION_BUCKETS,
} from '@platform/observability';
import { isObjectLike } from 'lodash-es';
import { TimeoutError } from 'rxjs';
import { grpcStatusName, isGrpcServiceError } from './grpc-status.mapping.js';

export const GRPC_SERVER_HANDLED_TOTAL = 'grpc_server_handled_total';
export const GRPC_SERVER_HANDLING_SECONDS = 'grpc_server_handling_seconds';
export const GRPC_CLIENT_HANDLED_TOTAL = 'grpc_client_handled_total';
export const GRPC_CLIENT_HANDLING_SECONDS = 'grpc_client_handling_seconds';

export interface GrpcCallTarget {
  readonly service: string;
  readonly method: string;
}

export type GrpcSide = 'client' | 'server';

/** `orders.v1.OrdersService/GetOrder` or a grpc-js path `/orders.v1.OrdersService/GetOrder`. */
export function parseGrpcOperation(operation: string): GrpcCallTarget {
  const path = operation.startsWith('/') ? operation.slice(1) : operation;
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { service: 'unknown', method: path }
    : { service: path.slice(0, slash), method: path.slice(slash + 1) };
}

/**
 * Client-side `grpc_code` of a failed call: the grpc-js status name, `DEADLINE_EXCEEDED` for the
 * local rxjs deadline, `CIRCUIT_OPEN` when the breaker rejected the call without sending it,
 * `UNKNOWN` otherwise.
 */
export function grpcClientCode(error: unknown): string {
  if (isGrpcServiceError(error)) return grpcStatusName(error.code);
  if (error instanceof TimeoutError) return 'DEADLINE_EXCEEDED';
  if (isObjectLike(error) && (error as { code?: unknown }).code === 'EOPENBREAKER') {
    return 'CIRCUIT_OPEN';
  }
  return 'UNKNOWN';
}

const handled = (side: GrpcSide) =>
  getOrCreateCounter({
    name: side === 'client' ? GRPC_CLIENT_HANDLED_TOTAL : GRPC_SERVER_HANDLED_TOTAL,
    help: `gRPC ${side} calls completed, by service, method and status code`,
    labelNames: ['grpc_service', 'grpc_method', 'grpc_code'],
  });

const handling = (side: GrpcSide) =>
  getOrCreateHistogram({
    name: side === 'client' ? GRPC_CLIENT_HANDLING_SECONDS : GRPC_SERVER_HANDLING_SECONDS,
    help: `gRPC ${side} call duration in seconds, by service and method`,
    labelNames: ['grpc_service', 'grpc_method'],
    buckets: [...HTTP_DURATION_BUCKETS],
  });

/** Records one finished unary call (`code` is `OK` on success). */
export function recordGrpcCall(
  side: GrpcSide,
  target: GrpcCallTarget,
  code: string,
  seconds: number,
): void {
  const labels = { grpc_service: target.service, grpc_method: target.method };
  handled(side).inc({ ...labels, grpc_code: code });
  handling(side).observe(labels, seconds);
}

export const GRPC_CIRCUIT_BREAKER_STATE = 'grpc_client_circuit_breaker_state';

export type CircuitState = 'open' | 'half-open' | 'closed';
const CIRCUIT_STATES: readonly CircuitState[] = ['closed', 'half-open', 'open'];
const breakerSources = new Set<() => Record<string, CircuitState>>();

/**
 * Adds a source of breaker states (one per `GrpcCircuitBreakers` instance) to
 * `grpc_client_circuit_breaker_state{upstream, state}`; returns its removal. Read on every scrape.
 */
export function trackCircuitBreakerStates(states: () => Record<string, CircuitState>): () => void {
  getOrCreateGauge({
    name: GRPC_CIRCUIT_BREAKER_STATE,
    help: 'gRPC client circuit breaker state per upstream: 1 for the current state (closed, half_open, open)',
    labelNames: ['upstream', 'state'],
    collect() {
      this.reset();
      for (const source of breakerSources) {
        for (const [upstream, current] of Object.entries(source())) {
          for (const state of CIRCUIT_STATES) {
            this.set({ upstream, state: state.replace('-', '_') }, state === current ? 1 : 0);
          }
        }
      }
    },
  });
  breakerSources.add(states);
  return () => {
    breakerSources.delete(states);
  };
}
