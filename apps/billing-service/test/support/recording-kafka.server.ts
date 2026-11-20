import { type CustomTransportStrategy, Server, Transport } from '@nestjs/microservices';

/**
 * Stands in for the `ServerKafka` behind `connectKafkaConsumer` (no broker): it carries the KAFKA
 * transport id, so Nest registers the app's `@KafkaEventPattern` handlers on it exactly as on the
 * real server, and `patterns()` lists the topics that got one.
 */
export class RecordingKafkaServer extends Server implements CustomTransportStrategy {
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
    throw new Error('RecordingKafkaServer has no underlying client');
  }

  /** The topics with a registered handler. */
  patterns(): string[] {
    return [...this.getHandlers().keys()];
  }
}
