import { Inject, Injectable, Logger, type OnApplicationBootstrap, Optional } from '@nestjs/common';
import {
  ExternalServiceException,
  generateId,
  isDomainException,
  type RetryOptions,
  retry,
} from '@platform/common';
import {
  createEventEnvelope,
  type EventContract,
  type EventEnvelope,
  KAFKA_HEADERS,
} from '@platform/contracts';
import { ClsService } from 'nestjs-cls';
import { lastValueFrom, type Observable } from 'rxjs';
import { z } from 'zod';
import { correlationIdFromCls } from '../context/transport-context.js';
import {
  KAFKA_ERROR_CODES,
  KAFKA_PRODUCER_CLIENT,
  KAFKA_PRODUCER_OPTIONS,
} from './kafka.constants.js';
import { InvalidEventException } from './kafka.errors.js';

/** Per-publish options. */
export interface KafkaPublishOptions {
  /**
   * Record key. Records with the same key go to the same partition and are consumed in order, so
   * use the aggregate id (e.g. `userId`). Without a key, records are spread over partitions.
   */
  key?: string | undefined;
  /** Correlation id. Default: the current nestjs-cls chain (see `correlationIdFromCls`). */
  correlationId?: string | undefined;
  /** Envelope id (uuidv7). Pass one to make a retried publish idempotent for consumers. */
  eventId?: string | undefined;
  /** When the fact happened. Default: now. */
  occurredAt?: Date | undefined;
}

/** The record handed to `ClientKafka.emit()`. Nest's serializer JSON-encodes `value`. */
export interface KafkaOutgoingRecord<TPayload = unknown> {
  key: string | null;
  value: EventEnvelope<TPayload>;
  headers: Record<string, string>;
}

/**
 * What `KafkaProducer` needs from `ClientKafka` (which satisfies it). Keeping it this small lets
 * tests pass a hand-written fake.
 */
export interface KafkaEventEmitter {
  emit(pattern: string, data: KafkaOutgoingRecord): Observable<unknown>;
  connect(): Promise<unknown>;
}

export interface KafkaProducerOptions {
  /** Envelope `source`: the producing service (`appConfig.serviceName`). */
  source: string;
  /**
   * Connect when the application boots, in the background. Default `true`. The first publish
   * would otherwise pay the connection latency. `ClientKafka` also connects lazily on emit, so
   * a broker that is down at boot does not block startup.
   */
  eagerConnect?: boolean | undefined;
  /**
   * Retries of the boot-time connect, on top of kafkajs' own connection retries. Default
   * `{ retries: 2, minDelayMs: 1000, maxDelayMs: 5000 }`.
   */
  connectRetry?: Pick<RetryOptions, 'retries' | 'minDelayMs' | 'maxDelayMs'> | undefined;
}

const DEFAULT_CONNECT_RETRY = { retries: 2, minDelayMs: 1_000, maxDelayMs: 5_000 } as const;

/**
 * Publishes integration events as validated `EventEnvelope`s. Every method takes the event's
 * contract (exported by the producing domain's contracts package), never a topic name:
 * - `id` uuidv7 (time-ordered; consumers dedupe on it), `type` = topic, `version` = the topic's
 *   major, `occurredAt`, `source` = this service, `correlationId` from the options or nestjs-cls.
 * - The envelope is validated against the contract's zod schema BEFORE it leaves the process, so
 *   an invalid payload fails in the producer instead of filling every consumer's dead-letter topic.
 * - Headers `x-event-type` and `x-correlation-id` let tools route and trace without parsing JSON.
 * - `acks: -1` + idempotent producer (see `createKafkaClientOptions`).
 *
 * `publish()` resolves once the broker acknowledged the record and throws `InvalidEventException`
 * or `ExternalServiceException` otherwise. Relays should catch and log (or use an outbox) rather
 * than fail the business operation that already committed.
 */
@Injectable()
export class KafkaProducer implements OnApplicationBootstrap {
  protected readonly logger = new Logger(KafkaProducer.name);

  constructor(
    @Inject(KAFKA_PRODUCER_CLIENT) private readonly client: KafkaEventEmitter,
    @Inject(KAFKA_PRODUCER_OPTIONS) protected readonly options: KafkaProducerOptions,
    @Optional() protected readonly cls?: ClsService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.eagerConnect === false) return;
    void this.connect();
  }

  /**
   * Connects the producer, retrying per `connectRetry`. Never rejects: resolves `false` (and logs)
   * when the broker stays unreachable, because `ClientKafka` reconnects on the next emit anyway.
   * Scripts that must fail fast can check the result.
   */
  async connect(): Promise<boolean> {
    try {
      await retry(() => this.client.connect(), {
        ...DEFAULT_CONNECT_RETRY,
        ...this.options.connectRetry,
        onRetry: (error, attempt) =>
          this.logger.warn(`Kafka producer connect attempt ${attempt} failed: ${String(error)}`),
      });
      this.logger.log('Kafka producer connected');
      return true;
    } catch (error) {
      // Not fatal: ClientKafka reconnects on the next emit(). Publishing is best-effort, so only
      // a process whose main job is consuming (notifications-service) gates readiness on Kafka.
      this.logger.error(
        'Kafka producer could not connect; it will retry on the next publish',
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
  }

  /** Builds and validates the envelope for `contract`. Throws `InvalidEventException`. */
  createEnvelope<TPayload>(
    contract: EventContract<TPayload>,
    payload: NoInfer<TPayload>,
    options: KafkaPublishOptions = {},
  ): EventEnvelope<TPayload> {
    try {
      return createEventEnvelope(contract, payload, {
        id: options.eventId ?? generateId(),
        source: this.options.source,
        correlationId: options.correlationId ?? correlationIdFromCls(this.cls),
        occurredAt: options.occurredAt,
      });
    } catch (error) {
      if (error instanceof z.core.$ZodError) {
        throw InvalidEventException.forTopic(contract.topic, error.issues, { cause: error });
      }
      throw error;
    }
  }

  /** The record `publish()` would send: key, validated envelope and headers. */
  createRecord<TPayload>(
    contract: EventContract<TPayload>,
    payload: NoInfer<TPayload>,
    options: KafkaPublishOptions = {},
  ): KafkaOutgoingRecord<TPayload> {
    const envelope = this.createEnvelope(contract, payload, options);
    const headers: Record<string, string> = { [KAFKA_HEADERS.EVENT_TYPE]: envelope.type };
    if (envelope.correlationId !== undefined) {
      headers[KAFKA_HEADERS.CORRELATION_ID] = envelope.correlationId;
    }
    return { key: options.key ?? null, value: envelope, headers };
  }

  /** Validates and publishes one event. Resolves with the envelope that was sent. */
  async publish<TPayload>(
    contract: EventContract<TPayload>,
    payload: NoInfer<TPayload>,
    options: KafkaPublishOptions = {},
  ): Promise<EventEnvelope<TPayload>> {
    const { topic } = contract;
    const record = this.createRecord(contract, payload, options);
    try {
      await this.dispatch(topic, record);
    } catch (error) {
      if (isDomainException(error)) throw error;
      throw new ExternalServiceException(`Failed to publish "${topic}" event`, {
        code: KAFKA_ERROR_CODES.PUBLISH_FAILED,
        cause: error,
        details: { topic, eventId: record.value.id },
      });
    }
    return record.value;
  }

  /** Sends a validated record. `FakeKafkaProducer` overrides this to record instead. */
  protected async dispatch<TPayload>(
    topic: string,
    record: KafkaOutgoingRecord<TPayload>,
  ): Promise<void> {
    // emit() is hot (already dispatched); awaiting it surfaces broker errors and the ack.
    await lastValueFrom(this.client.emit(topic, record), { defaultValue: undefined });
  }
}
