import { Inject, Injectable, Optional } from '@nestjs/common';
import type { EventContract, EventEnvelope } from '@platform/contracts';
import { ClsService } from 'nestjs-cls';
import { EMPTY } from 'rxjs';
import { KAFKA_PRODUCER_OPTIONS } from '../kafka.constants.js';
import {
  type KafkaEventEmitter,
  type KafkaOutgoingRecord,
  KafkaProducer,
  type KafkaProducerOptions,
} from '../kafka-producer.service.js';

/** One record captured by `FakeKafkaProducer`. */
export interface PublishedKafkaRecord<TPayload = unknown> extends KafkaOutgoingRecord<TPayload> {
  topic: string;
}

/** Never used: `FakeKafkaProducer` overrides `dispatch()`, the only caller of the emitter. */
const DETACHED_EMITTER: KafkaEventEmitter = {
  emit: () => EMPTY,
  connect: () => Promise.resolve(),
};

/**
 * In-memory `KafkaProducer` for unit and e2e tests. It builds and validates envelopes exactly
 * like the real producer (an invalid payload still throws `InvalidEventException`), then records
 * the record instead of sending it:
 *
 * ```ts
 * const producer = new FakeKafkaProducer();
 * moduleBuilder.overrideProvider(KafkaProducer).useValue(producer);
 * expect(producer.published(ORDER_PLACED_EVENT)[0]?.value.payload.orderId).toBe(id);
 * ```
 *
 * `failNextWith(error)` makes the next publish fail like a broker error would.
 */
@Injectable()
export class FakeKafkaProducer extends KafkaProducer {
  readonly records: PublishedKafkaRecord[] = [];
  private pendingFailure: unknown;

  constructor(
    @Optional() @Inject(KAFKA_PRODUCER_OPTIONS) options?: Partial<KafkaProducerOptions>,
    @Optional() cls?: ClsService,
  ) {
    super(DETACHED_EMITTER, { source: options?.source ?? 'test', eagerConnect: false }, cls);
  }

  override onApplicationBootstrap(): void {
    // Nothing to connect.
  }

  override connect(): Promise<boolean> {
    return Promise.resolve(true);
  }

  /** Records published so far, optionally only those of `contract`'s topic. */
  published<TPayload>(contract?: EventContract<TPayload>): PublishedKafkaRecord<TPayload>[] {
    if (contract === undefined) return [...this.records] as PublishedKafkaRecord<TPayload>[];
    return this.records.filter(
      (record): record is PublishedKafkaRecord<TPayload> => record.topic === contract.topic,
    );
  }

  /** Envelopes published to `contract`'s topic, in order. */
  envelopes<TPayload>(contract: EventContract<TPayload>): EventEnvelope<TPayload>[] {
    return this.published(contract).map((record) => record.value);
  }

  /** Makes the next `publish()` reject as if the broker had failed with `error`. */
  failNextWith(error: unknown = new Error('Simulated broker failure')): void {
    this.pendingFailure = error;
  }

  clear(): void {
    this.records.length = 0;
    this.pendingFailure = undefined;
  }

  protected override dispatch<TPayload>(
    topic: string,
    record: KafkaOutgoingRecord<TPayload>,
  ): Promise<void> {
    if (this.pendingFailure !== undefined) {
      const failure = this.pendingFailure;
      this.pendingFailure = undefined;
      return Promise.reject(
        failure instanceof Error
          ? failure
          : new Error('Simulated broker failure', { cause: failure }),
      );
    }
    this.records.push({ topic, ...record });
    return Promise.resolve();
  }
}
