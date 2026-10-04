import { AsyncLocalStorage } from 'node:async_hooks';
import { generateId } from '@app/common';
import { KAFKA_TOPICS } from '@app/contracts';
import { status as GrpcStatus, Metadata } from '@grpc/grpc-js';
import {
  type ArgumentsHost,
  type CallHandler,
  type ExecutionContext,
  Logger,
} from '@nestjs/common';
import { KafkaContext, KafkaRetriableException, RpcException } from '@nestjs/microservices';
import { CLS_ID, ClsService } from 'nestjs-cls';
import { defer, lastValueFrom, of } from 'rxjs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { exceptionToGrpcError } from '../grpc/grpc-status.mapping.js';
import { KafkaContextInterceptor } from '../kafka/kafka-context.interceptor.js';
import { KafkaDeadLetterFilter } from '../kafka/kafka-dead-letter.filter.js';
import { isInstanceAcrossRealms, isKafkaContext } from './realm.js';

/*
 * "Foreign" classes: what the OTHER installed copy of @nestjs/microservices hands us at runtime.
 * Same names and methods, different identity, so `instanceof` against our import is false.
 */
const foreign = (() => {
  class RpcException extends Error {
    constructor(private readonly error: string | object) {
      super(typeof error === 'string' ? error : 'rpc');
    }
    getError(): string | object {
      return this.error;
    }
  }
  class KafkaRetriableException extends RpcException {}
  class GrpcException extends RpcException {
    constructor(
      private readonly code: number,
      message: string,
    ) {
      super({ code, message });
      this.message = message;
    }
    getCode(): number {
      return this.code;
    }
  }
  class KafkaContext {
    constructor(private readonly send: (record: unknown) => Promise<unknown>) {}
    getMessage() {
      return {
        key: 'k',
        value: { id: 'e1' },
        headers: { 'x-correlation-id': 'corr-f' },
        offset: '7',
      };
    }
    getPartition() {
      return 3;
    }
    getTopic() {
      return KAFKA_TOPICS.USER_REGISTERED;
    }
    getProducer() {
      return { send: this.send };
    }
  }
  return { RpcException, KafkaRetriableException, GrpcException, KafkaContext };
})();

const rpcHost = (context: unknown, data: unknown = undefined): ArgumentsHost & ExecutionContext =>
  ({
    getType: () => 'rpc',
    switchToRpc: () => ({ getContext: () => context, getData: () => data }),
  }) as unknown as ArgumentsHost & ExecutionContext;

describe('realm-safe class checks', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('isKafkaContext accepts our KafkaContext and one from another package copy', () => {
    const ours = new KafkaContext([
      { offset: '1' } as never,
      0,
      KAFKA_TOPICS.USER_REGISTERED,
      {} as never,
      () => Promise.resolve(),
      {} as never,
    ]);
    expect(isKafkaContext(ours)).toBe(true);
    expect(isKafkaContext(new foreign.KafkaContext(vi.fn()))).toBe(true);
    // gRPC hands handlers a Metadata as context: never mistaken for Kafka.
    for (const other of [new Metadata(), {}, null, undefined, 'ctx', 42]) {
      expect(isKafkaContext(other)).toBe(false);
    }
  });

  it('isInstanceAcrossRealms matches by class name along the prototype chain', () => {
    expect(isInstanceAcrossRealms(new RpcException('x'), RpcException, 'RpcException')).toBe(true);
    expect(
      isInstanceAcrossRealms(new foreign.RpcException('x'), RpcException, 'RpcException'),
    ).toBe(true);
    // Subclass of a foreign RpcException.
    expect(
      isInstanceAcrossRealms(
        new foreign.KafkaRetriableException('x'),
        RpcException,
        'RpcException',
      ),
    ).toBe(true);
    expect(isInstanceAcrossRealms(new Error('x'), RpcException, 'RpcException')).toBe(false);
    expect(isInstanceAcrossRealms('RpcException', RpcException, 'RpcException')).toBe(false);
    expect(isInstanceAcrossRealms(null, RpcException, 'RpcException')).toBe(false);
  });

  it('KafkaDeadLetterFilter dead-letters for a foreign KafkaContext and emits null', async () => {
    const send = vi.fn(async (_record: unknown) => []);
    const filter = new KafkaDeadLetterFilter();

    await expect(
      lastValueFrom(filter.catch(new Error('boom'), rpcHost(new foreign.KafkaContext(send)))),
    ).resolves.toBeNull();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ topic: `${KAFKA_TOPICS.USER_REGISTERED}.dlq`, acks: -1 }),
    );
  });

  it('KafkaDeadLetterFilter rethrows a foreign KafkaRetriableException (kafkajs retries)', async () => {
    const send = vi.fn(async (_record: unknown) => []);
    const retriable = new foreign.KafkaRetriableException('again');
    await expect(
      lastValueFrom(
        new KafkaDeadLetterFilter().catch(retriable, rpcHost(new foreign.KafkaContext(send))),
      ),
    ).rejects.toBe(retriable);
    await expect(
      lastValueFrom(
        new KafkaDeadLetterFilter().catch(
          new KafkaRetriableException('again'),
          rpcHost(new foreign.KafkaContext(send)),
        ),
      ),
    ).rejects.toBeInstanceOf(KafkaRetriableException);
    expect(send).not.toHaveBeenCalled();
  });

  it('KafkaContextInterceptor opens the CLS context for a foreign KafkaContext', async () => {
    const cls = new ClsService(new AsyncLocalStorage());
    const eventId = generateId();
    const next: CallHandler = {
      handle: () => defer(() => of(cls.isActive() ? cls.get<unknown>(CLS_ID) : 'inactive')),
    };

    const seen = await lastValueFrom(
      new KafkaContextInterceptor(cls).intercept(
        rpcHost(new foreign.KafkaContext(vi.fn()), { id: eventId }),
        next,
      ),
    );
    expect(seen).toBe(eventId);
  });

  it('exceptionToGrpcError passes foreign GrpcException / RpcException codes through', () => {
    expect(
      exceptionToGrpcError(new foreign.GrpcException(GrpcStatus.NOT_FOUND, 'gone')),
    ).toMatchObject({ code: GrpcStatus.NOT_FOUND, message: 'gone' });
    expect(
      exceptionToGrpcError(
        new foreign.RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'nope' }),
      ),
    ).toMatchObject({ code: GrpcStatus.PERMISSION_DENIED });
    // Not an RpcException of any copy: still hidden as INTERNAL.
    expect(exceptionToGrpcError(new Error('secret'))).toMatchObject({ code: GrpcStatus.INTERNAL });
  });
});
