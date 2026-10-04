import { KAFKA_TOPICS } from '@app/contracts';
import { EXCEPTION_FILTERS_METADATA, INTERCEPTORS_METADATA } from '@nestjs/common/constants.js';
import { Ctx, type KafkaContext, Payload, Transport } from '@nestjs/microservices';
import {
  PATTERN_HANDLER_METADATA,
  PATTERN_METADATA,
  TRANSPORT_METADATA,
} from '@nestjs/microservices/constants.js';
import { describe, expect, it } from 'vitest';
import { KafkaConsumerController } from './kafka-consumer.decorator.js';
import { KafkaContextInterceptor } from './kafka-context.interceptor.js';
import { KafkaDeadLetterFilter } from './kafka-dead-letter.filter.js';
import { KafkaEventPattern } from './kafka-event-pattern.decorator.js';
import { KafkaRetryInterceptor } from './kafka-retry.interceptor.js';

@KafkaConsumerController()
class UserEventsConsumer {
  // A typed `@Ctx() KafkaContext` parameter compiles: this is the TS1241 regression guard.
  @KafkaEventPattern(KAFKA_TOPICS.USER_REGISTERED)
  onUserRegistered(@Payload() _payload: unknown, @Ctx() _ctx: KafkaContext): Promise<void> {
    return Promise.resolve();
  }

  @KafkaEventPattern(`${KAFKA_TOPICS.USER_REGISTERED}.dlq`)
  replay(@Payload() _payload: unknown): void {
    // Metadata-only fixture.
  }
}

describe('@KafkaEventPattern()', () => {
  it('registers an event handler for the topic, bound to the Kafka transport only', () => {
    const handler = Object.getOwnPropertyDescriptor(
      UserEventsConsumer.prototype,
      'onUserRegistered',
    )?.value as object;
    expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual(['identity.user-registered.v1']);
    expect(Reflect.getMetadata(TRANSPORT_METADATA, handler)).toBe(Transport.KAFKA);
    expect(Reflect.getMetadata(PATTERN_HANDLER_METADATA, handler)).toBe(2); // PatternHandler.EVENT

    const replay = Object.getOwnPropertyDescriptor(UserEventsConsumer.prototype, 'replay')
      ?.value as object;
    expect(Reflect.getMetadata(PATTERN_METADATA, replay)).toEqual([
      'identity.user-registered.v1.dlq',
    ]);
  });
});

describe('@KafkaConsumerController()', () => {
  it('applies the dead-letter filter, the context and (inside it) the retry interceptor', () => {
    expect(Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, UserEventsConsumer)).toEqual([
      KafkaDeadLetterFilter,
    ]);
    const interceptors = Reflect.getMetadata(
      INTERCEPTORS_METADATA,
      UserEventsConsumer,
    ) as unknown[];
    expect(interceptors).toHaveLength(2);
    expect(interceptors[0]).toBe(KafkaContextInterceptor);
    expect(interceptors[1]).toBeInstanceOf(KafkaRetryInterceptor);
  });
});
