import { EventEmitter } from 'node:events';
import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';
import { KafkaContext, ServerKafka } from '@nestjs/microservices';
import type { ClsService } from 'nestjs-cls';
import { register } from 'prom-client';
import { defer, lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { InstrumentedServerKafka } from './instrumented-server-kafka.js';
import { KafkaContextInterceptor } from './kafka-context.interceptor.js';
import { KafkaDeadLetterFilter } from './kafka-dead-letter.filter.js';
import {
  instrumentKafkaConsumer,
  type KafkaConsumerLike,
  recordKafkaOutcome,
  recordKafkaRetry,
} from './kafka-metrics.js';
import { KafkaRetryInterceptor } from './kafka-retry.interceptor.js';

async function value(name: string, labels: Record<string, string>): Promise<number> {
  const metric = register.getSingleMetric(name);
  if (metric === undefined) return 0;
  const { values } = await metric.get();
  return (
    values.find((sample) =>
      Object.entries(labels).every(([key, label]) => sample.labels[key] === label),
    )?.value ?? 0
  );
}

function fakeConsumer(): { consumer: KafkaConsumerLike; emitter: EventEmitter } {
  const emitter = new EventEmitter();
  const consumer = {
    events: { END_BATCH_PROCESS: 'consumer.end_batch_process' },
    on: (event: string, listener: (payload: unknown) => void) => emitter.on(event, listener),
  } as unknown as KafkaConsumerLike;
  return { consumer, emitter };
}

describe('Kafka consumer metrics', () => {
  it('counts outcomes and retries per topic', async () => {
    const topic = 'test.metrics.v1';
    const before = await value('kafka_consumer_messages_total', { topic, outcome: 'dead_letter' });
    recordKafkaOutcome(topic, 'dead_letter');
    recordKafkaRetry(topic);
    expect(await value('kafka_consumer_messages_total', { topic, outcome: 'dead_letter' })).toBe(
      before + 1,
    );
    expect(await value('kafka_consumer_retries_total', { topic })).toBeGreaterThan(0);
  });

  it('sets the lag of each partition at the end of every batch', async () => {
    const { consumer, emitter } = fakeConsumer();
    instrumentKafkaConsumer(consumer, 'orders-push');
    emitter.emit('consumer.end_batch_process', {
      payload: { topic: 'orders.created.v1', partition: 2, offsetLag: '42' },
    });
    expect(
      await value('kafka_consumer_lag', {
        group: 'orders-push',
        topic: 'orders.created.v1',
        partition: '2',
      }),
    ).toBe(42);
  });

  it('InstrumentedServerKafka instruments the consumer before Nest binds its handlers', async () => {
    const bind = vi.spyOn(ServerKafka.prototype, 'bindEvents').mockResolvedValue(undefined);
    const server = new InstrumentedServerKafka({ consumer: { groupId: 'g1' } });
    const { consumer, emitter } = fakeConsumer();
    await server.bindEvents(consumer);
    expect(bind).toHaveBeenCalledWith(consumer);
    expect(emitter.listenerCount('consumer.end_batch_process')).toBe(1);
  });

  describe('through the real consumer pipeline', () => {
    const message = (topic: string) =>
      new KafkaContext([
        {
          key: null,
          value: Buffer.from('{"id":"evt-1"}'),
          headers: {},
          offset: '7',
          timestamp: '0',
          attributes: 0,
          size: 0,
        } as never,
        0,
        topic,
        {} as never,
        async () => undefined,
        { send: vi.fn().mockResolvedValue([]) } as never,
      ]);
    const rpc = (context: KafkaContext) =>
      ({
        getType: () => 'rpc',
        switchToRpc: () => ({ getContext: () => context, getData: () => ({ id: 'evt-1' }) }),
      }) as unknown as ExecutionContext & ArgumentsHost;
    const cls = {
      run: (_options: unknown, fn: () => unknown) => fn(),
      set: () => undefined,
    } as unknown as ClsService;

    it('KafkaContextInterceptor counts a handled message as success', async () => {
      const topic = 'test.success.v1';
      const before = await value('kafka_consumer_messages_total', { topic, outcome: 'success' });
      await lastValueFrom(
        new KafkaContextInterceptor(cls).intercept(rpc(message(topic)), { handle: () => of('ok') }),
      );
      expect(await value('kafka_consumer_messages_total', { topic, outcome: 'success' })).toBe(
        before + 1,
      );
    });

    it('KafkaRetryInterceptor counts each in-process retry', async () => {
      const topic = 'test.retry.v1';
      let calls = 0;
      const handler = {
        handle: () =>
          defer(() => (calls++ === 0 ? throwError(() => new Error('transient')) : of('ok'))),
      };
      await lastValueFrom(
        new KafkaRetryInterceptor({ attempts: 2 }).intercept(rpc(message(topic)), handler),
      );
      expect(await value('kafka_consumer_retries_total', { topic })).toBe(1);
    });

    it('KafkaDeadLetterFilter counts dead letters, and redelivery when the DLQ publish fails', async () => {
      const topic = 'test.dlq.v1';
      await lastValueFrom(
        new KafkaDeadLetterFilter().catch(new Error('poison'), rpc(message(topic))),
      );
      expect(await value('kafka_consumer_messages_total', { topic, outcome: 'dead_letter' })).toBe(
        1,
      );

      const broken = message(topic);
      vi.mocked(broken.getProducer().send).mockRejectedValue(new Error('broker down'));
      await expect(
        lastValueFrom(new KafkaDeadLetterFilter().catch(new Error('poison'), rpc(broken))),
      ).rejects.toThrow('poison');
      expect(await value('kafka_consumer_messages_total', { topic, outcome: 'redelivery' })).toBe(
        1,
      );
    });
  });
});
