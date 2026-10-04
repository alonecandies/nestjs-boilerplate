import {
  type CustomTransportStrategy,
  KafkaContext,
  Server,
  Transport,
} from '@nestjs/microservices';
import { isObservable, lastValueFrom } from 'rxjs';
import { vi } from 'vitest';

type KafkaContextArgs = ConstructorParameters<typeof KafkaContext>[0];

export interface SentRecord {
  topic: string;
  acks?: number;
  messages: { key: unknown; value: unknown; headers: Record<string, unknown> }[];
}

/**
 * A Kafka "broker" for unit tests: Nest registers the `@KafkaEventPattern` handlers on it exactly
 * as on `ServerKafka` (same transport id, errors propagated), and `dispatch()` runs a message
 * through the full RPC pipeline — pipes, interceptors, controller-scoped filters — with a real
 * `KafkaContext` whose producer records what the dead-letter filter sends.
 */
export class InMemoryKafkaServer extends Server implements CustomTransportStrategy {
  override readonly propagatesEventHandlerErrors = true;
  readonly producer = { send: vi.fn(async (_record: SentRecord) => [] as unknown[]) };

  constructor() {
    super();
    this.setTransportId(Transport.KAFKA);
  }

  listen(callback: () => void): void {
    callback();
  }

  close(): void {
    // Nothing to release.
  }

  on(): void {
    // No broker events.
  }

  unwrap<T>(): T {
    throw new Error('InMemoryKafkaServer has no underlying client');
  }

  /** Delivers `value` (already JSON-decoded, like Nest's KafkaParser) to the topic's handler. */
  async dispatch(topic: string, value: unknown, key: string | null = null): Promise<void> {
    const handler = this.getHandlerByPattern(topic);
    if (!handler) throw new Error(`No handler registered for ${topic}`);
    const message = {
      key,
      value,
      headers: { 'x-event-type': topic },
      offset: '42',
      timestamp: String(Date.now()),
      attributes: 0,
      size: 0,
    };
    const context = new KafkaContext([
      message,
      0,
      topic,
      {},
      async () => undefined,
      this.producer,
    ] as unknown as KafkaContextArgs);
    const result: unknown = await handler(value, context);
    if (isObservable(result)) await lastValueFrom(result, { defaultValue: undefined });
  }

  /** Records sent to `<topic>.dlq` by `KafkaDeadLetterFilter`. */
  deadLetters(): SentRecord[] {
    return this.producer.send.mock.calls
      .map(([record]) => record)
      .filter((record) => record.topic.endsWith('.dlq'));
  }
}
