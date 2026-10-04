import {
  type CustomTransportStrategy,
  KafkaContext,
  Server,
  Transport,
} from '@nestjs/microservices';
import { isObservable, lastValueFrom } from 'rxjs';
import { vi } from 'vitest';

type KafkaContextArgs = ConstructorParameters<typeof KafkaContext>[0];

export interface SentKafkaRecord {
  topic: string;
  messages: { key: unknown; value: unknown; headers: Record<string, unknown> }[];
}

/**
 * Stands in for the broker behind `connectKafkaConsumer`: it carries the KAFKA transport id, so
 * Nest registers the app's `@KafkaEventPattern` handlers on it exactly as on `ServerKafka`, and
 * `deliver()` runs one message through the full RPC pipeline (inherited global enhancers, pipes,
 * controller-scoped dead-letter filter + interceptor) with a real `KafkaContext` whose producer
 * records what the dead-letter filter sends.
 */
export class InMemoryKafkaServer extends Server implements CustomTransportStrategy {
  override readonly propagatesEventHandlerErrors = true;
  readonly producer = { send: vi.fn(async (_record: SentKafkaRecord) => [] as unknown[]) };

  constructor() {
    super();
    this.setTransportId(Transport.KAFKA);
  }

  listen(callback: () => void): void {
    callback();
  }

  close(): void {
    // No connections.
  }

  on(): void {
    // No broker events.
  }

  unwrap<T>(): T {
    throw new Error('InMemoryKafkaServer has no underlying client');
  }

  /** Delivers `value` (JSON-decoded, as Nest's KafkaParser hands it over) on `topic`. */
  async deliver(topic: string, value: unknown, key: string | null = null): Promise<void> {
    const handler = this.getHandlerByPattern(topic);
    if (!handler) throw new Error(`No consumer registered for ${topic}`);
    const message = {
      key,
      value,
      headers: { 'x-event-type': topic },
      offset: '0',
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

  /** Records published to `<topic>.dlq` by `KafkaDeadLetterFilter`. */
  deadLetters(): SentKafkaRecord[] {
    return this.producer.send.mock.calls
      .map(([record]) => record)
      .filter((record) => record.topic.endsWith('.dlq'));
  }
}
