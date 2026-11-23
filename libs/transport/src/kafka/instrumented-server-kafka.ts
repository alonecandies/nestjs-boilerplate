import { type KafkaOptions, ServerKafka } from '@nestjs/microservices';
import {
  initKafkaTopicMetrics,
  instrumentKafkaConsumer,
  type KafkaConsumerLike,
} from './kafka-metrics.js';

/**
 * Nest's Kafka server plus consumer-lag instrumentation, and the outcome series of every subscribed
 * topic started at 0 before it consumes (so the first dead letter alerts). `connectKafkaConsumer()`
 * connects it as a custom strategy with the options `createKafkaServerOptions()` builds, so the
 * transport id (`Transport.KAFKA`), consumer group and handlers are unchanged.
 */
export class InstrumentedServerKafka extends ServerKafka {
  constructor(readonly kafkaOptions: Required<KafkaOptions>['options']) {
    super(kafkaOptions);
  }

  override async bindEvents(consumer: KafkaConsumerLike): Promise<void> {
    instrumentKafkaConsumer(consumer, this.groupId);
    for (const topic of this.messageHandlers.keys()) initKafkaTopicMetrics(topic);
    await super.bindEvents(consumer);
  }
}
