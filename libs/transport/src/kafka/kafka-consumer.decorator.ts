import { applyDecorators, Controller, UseFilters, UseInterceptors } from '@nestjs/common';
import { KafkaContextInterceptor } from './kafka-context.interceptor.js';
import { KafkaDeadLetterFilter } from './kafka-dead-letter.filter.js';
import { KafkaRetryInterceptor, type KafkaRetryOptions } from './kafka-retry.interceptor.js';

export interface KafkaConsumerControllerOptions {
  /** In-process retry of transient failures. Default `DEFAULT_KAFKA_RETRY_OPTIONS`. */
  retry?: Partial<KafkaRetryOptions>;
}

/**
 * Use this instead of `@Controller()` on Kafka consumer controllers. It applies, at controller
 * scope:
 * - `KafkaContextInterceptor`: request/correlation ids in nestjs-cls;
 * - `KafkaRetryInterceptor` (inside it): a transient failure (driver, connection, timeout,
 *   5xx-class `DomainException`) is retried a few times with backoff;
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
