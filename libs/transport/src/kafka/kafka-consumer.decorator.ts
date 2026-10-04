import { applyDecorators, Controller, UseFilters, UseInterceptors } from '@nestjs/common';
import { KafkaContextInterceptor } from './kafka-context.interceptor.js';
import { KafkaDeadLetterFilter } from './kafka-dead-letter.filter.js';

/**
 * Use this instead of `@Controller()` on Kafka consumer controllers. It applies, at controller
 * scope, `KafkaDeadLetterFilter` (a failing handler never blocks its partition) and
 * `KafkaContextInterceptor` (request/correlation ids in nestjs-cls). Controller scope keeps them
 * off the HTTP and gRPC handlers of a hybrid app. Equivalent to
 * `@Controller() @UseFilters(KafkaDeadLetterFilter) @UseInterceptors(KafkaContextInterceptor)`.
 */
export const KafkaConsumerController = (): ClassDecorator =>
  applyDecorators(
    Controller(),
    UseFilters(KafkaDeadLetterFilter),
    UseInterceptors(KafkaContextInterceptor),
  );
