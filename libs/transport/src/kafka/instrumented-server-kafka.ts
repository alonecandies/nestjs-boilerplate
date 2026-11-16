import { type KafkaOptions, ServerKafka } from '@nestjs/microservices';
import { instrumentKafkaConsumer, type KafkaConsumerLike } from './kafka-metrics.js';

/**
 * Nest's Kafka server plus consumer-lag instrumentation. `connectKafkaConsumer()` connects it as a
 * custom strategy with the options `createKafkaServerOptions()` builds, so the transport id
 * (`Transport.KAFKA`), consumer group and handlers are unchanged.
 */
export class InstrumentedServerKafka extends ServerKafka {
  constructor(readonly kafkaOptions: Required<KafkaOptions>['options']) {
    super(kafkaOptions);
  }

  override async bindEvents(consumer: KafkaConsumerLike): Promise<void> {
    instrumentKafkaConsumer(consumer, this.groupId);
    await super.bindEvents(consumer);
  }
}
