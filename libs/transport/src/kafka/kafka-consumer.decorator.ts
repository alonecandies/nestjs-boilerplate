import { applyDecorators, Controller, UseFilters, UseInterceptors } from '@nestjs/common';
import { KafkaContextInterceptor } from './kafka-context.interceptor.js';
import { KafkaDeadLetterFilter } from './kafka-dead-letter.filter.js';
import { KafkaRetryInterceptor, type KafkaRetryOptions } from './kafka-retry.interceptor.js';

export interface KafkaConsumerControllerOptions {
  /**
   * In-process retry of transient failures, the budget of one message's work and what a spent
   * budget becomes (`onBudgetExceeded`). Default `DEFAULT_KAFKA_RETRY_OPTIONS`. Write `budgetMs` as
   * a number literal: `kafka.options.spec.ts` reads it from the source to check the timing.
   */
  retry?: Partial<KafkaRetryOptions>;
}

/**
 * Use this instead of `@Controller()` on Kafka consumer controllers. It applies, at controller
 * scope:
 * - `KafkaContextInterceptor`: request/correlation ids in nestjs-cls;
 * - `KafkaRetryInterceptor` (inside it): a transient failure (driver, connection, timeout,
 *   5xx-class `DomainException`) is retried a few times with backoff, all of the message's work
 *   shares one budget (40 s), and the consumer heartbeats while it runs;
 * - `KafkaDeadLetterFilter`: whatever still fails goes to `<topic>.dlq` and never blocks its
 *   partition.
 * Controller scope keeps them off the HTTP and gRPC handlers of a hybrid app.
 */
export const KafkaConsumerController = (
  options: KafkaConsumerControllerOptions = {},
): ClassDecorator =>
  applyDecorators(
    Controller(),
    UseFilters(KafkaDeadLetterFilter),
    UseInterceptors(KafkaContextInterceptor, new KafkaRetryInterceptor(options.retry)),
  );
