import {
  EntityNotFoundException,
  ExternalServiceException,
  OperationTimeoutException,
  ServiceUnavailableException,
} from '@app/common';
import { Metadata } from '@grpc/grpc-js';
import { Logger } from '@nestjs/common';
import { GrpcStatus } from '@nestjs/microservices';
import { defer, Observable, of, throwError } from 'rxjs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { grpcCall } from './grpc-call.js';
import { GrpcCircuitBreakers, isCallerError } from './grpc-circuit-breakers.js';
import type { GrpcServiceErrorLike } from './grpc-status.mapping.js';

const serviceError = (code: GrpcStatus, details = 'upstream'): Error & GrpcServiceErrorLike =>
  Object.assign(new Error(`${code} ${GrpcStatus[code]}: ${details}`), {
    code,
    details,
    metadata: new Metadata(),
  });

beforeAll(() => {
  Logger.overrideLogger(false);
});

describe('grpcCall', () => {
  const registries: GrpcCircuitBreakers[] = [];
  const breakers = (overrides = {}): GrpcCircuitBreakers => {
    const registry = new GrpcCircuitBreakers(overrides);
    registries.push(registry);
    return registry;
  };

  afterEach(() => {
    for (const registry of registries.splice(0)) registry.onApplicationShutdown();
    vi.useRealTimers();
  });

  it('resolves the last value of a unary call', async () => {
    await expect(grpcCall(of({ id: 'u1' }), { timeoutMs: 100, operation: 'op' })).resolves.toEqual({
      id: 'u1',
    });
  });

  it('subscribes lazily, so a cold ClientGrpc observable is called exactly once', async () => {
    const call = vi.fn(() => of('ok'));
    await grpcCall(defer(call), { timeoutMs: 100, operation: 'op', breaker: breakers().get('x') });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('fails with OperationTimeoutException when the deadline passes, and cancels the call', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    // Like ClientGrpc: unsubscribing runs the teardown, which calls `call.cancel()`.
    const hanging = new Observable<never>(() => cancel);
    const result = grpcCall(hanging, { timeoutMs: 1_000, operation: 'identity.GetUser' });
    const assertion = expect(result).rejects.toMatchObject({
      details: { operation: 'identity.GetUser' },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    await expect(result).rejects.toBeInstanceOf(OperationTimeoutException);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('maps a NOT_FOUND ServiceError to EntityNotFoundException', async () => {
    const call = throwError(() => serviceError(GrpcStatus.NOT_FOUND, 'User u1 not found'));
    const error: unknown = await grpcCall(call, { timeoutMs: 100, operation: 'op' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EntityNotFoundException);
    expect(error).toMatchObject({ message: 'User u1 not found', httpStatus: 404 });
  });

  it('hides details of an UNAVAILABLE upstream', async () => {
    const call = throwError(() =>
      serviceError(GrpcStatus.UNAVAILABLE, 'connect ECONNREFUSED 127.0.0.1:50051'),
    );
    const error: unknown = await grpcCall(call, { timeoutMs: 100, operation: 'op' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).not.toContain('ECONNREFUSED');
  });

  it('opens the circuit on upstream failures, then fails fast without calling', async () => {
    const breaker = breakers({ volumeThreshold: 2, errorThresholdPercentage: 50 }).get('identity');
    const upstream = vi.fn(() => throwError(() => serviceError(GrpcStatus.UNAVAILABLE)));
    const options = { timeoutMs: 100, operation: 'op', breaker };

    for (let i = 0; i < 3; i++) {
      await expect(grpcCall(defer(upstream), options)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    }
    expect(breaker.opened).toBe(true);
    const callsBefore = upstream.mock.calls.length;

    const error: unknown = await grpcCall(defer(upstream), options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error).toMatchObject({ details: { reason: 'EOPENBREAKER' } });
    expect(upstream.mock.calls.length).toBe(callsBefore);
  });

  it('does not open the circuit on caller errors (errorFilter)', async () => {
    const breaker = breakers({ volumeThreshold: 2, errorThresholdPercentage: 1 }).get('identity');
    const upstream = (): Observable<never> => throwError(() => serviceError(GrpcStatus.NOT_FOUND));
    for (let i = 0; i < 10; i++) {
      await expect(
        grpcCall(defer(upstream), { timeoutMs: 100, operation: 'op', breaker }),
      ).rejects.toBeInstanceOf(EntityNotFoundException);
    }
    expect(breaker.opened).toBe(false);
  });

  it('maps non-gRPC failures to ExternalServiceException', async () => {
    await expect(
      grpcCall(
        throwError(() => new Error('socket hang up')),
        { timeoutMs: 100, operation: 'op' },
      ),
    ).rejects.toBeInstanceOf(ExternalServiceException);
  });
});

describe('isCallerError (breaker errorFilter)', () => {
  it.each([
    [GrpcStatus.INVALID_ARGUMENT, true],
    [GrpcStatus.NOT_FOUND, true],
    [GrpcStatus.ALREADY_EXISTS, true],
    [GrpcStatus.PERMISSION_DENIED, true],
    [GrpcStatus.UNAUTHENTICATED, true],
    [GrpcStatus.FAILED_PRECONDITION, true],
    [GrpcStatus.OUT_OF_RANGE, true],
    [GrpcStatus.ABORTED, true],
    [GrpcStatus.RESOURCE_EXHAUSTED, false],
    [GrpcStatus.UNAVAILABLE, false],
    [GrpcStatus.DEADLINE_EXCEEDED, false],
    [GrpcStatus.INTERNAL, false],
    [GrpcStatus.UNKNOWN, false],
  ])('status %s → caller error: %s', (code, expected) => {
    expect(isCallerError(serviceError(code))).toBe(expected);
  });

  it('classifies DomainExceptions by HTTP status and ignores anything else', () => {
    expect(isCallerError(new EntityNotFoundException('User', 'u1'))).toBe(true);
    expect(isCallerError(new ServiceUnavailableException())).toBe(false);
    expect(isCallerError(new Error('boom'))).toBe(false);
  });
});

describe('GrpcCircuitBreakers', () => {
  it('creates one breaker per upstream and reports states', () => {
    const registry = new GrpcCircuitBreakers();
    const identity = registry.get('identity');
    expect(registry.get('identity')).toBe(identity);
    expect(registry.get('billing')).not.toBe(identity);
    expect(registry.states()).toEqual({ identity: 'closed', billing: 'closed' });
    identity.open();
    expect(registry.states()['identity']).toBe('open');
    registry.onApplicationShutdown();
    expect(registry.states()).toEqual({});
  });

  it('applies overrides over the defaults', async () => {
    // volumeThreshold 1 + threshold 1 %: a single upstream failure opens the circuit.
    const registry = new GrpcCircuitBreakers({ volumeThreshold: 1, errorThresholdPercentage: 1 });
    const breaker = registry.get('x');
    expect(breaker.name).toBe('x');
    await expect(
      breaker.fire(() => Promise.reject(serviceError(GrpcStatus.UNAVAILABLE))),
    ).rejects.toMatchObject({ code: GrpcStatus.UNAVAILABLE });
    expect(breaker.opened).toBe(true);
    registry.onApplicationShutdown();
  });
});
