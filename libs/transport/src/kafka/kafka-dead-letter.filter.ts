import { isDomainException } from '@app/common';
import {
  type ArgumentsHost,
  Catch,
  HttpStatus,
  Logger,
  type RpcExceptionFilter,
} from '@nestjs/common';
import { KafkaContext, KafkaRetriableException } from '@nestjs/microservices';
import { defer, map, type Observable, throwError } from 'rxjs';
import { errorTypeOf, sendToDeadLetter } from './dead-letter.js';

/**
 * Controller-scoped catch-all for Kafka consumers (`@UseFilters(KafkaDeadLetterFilter)`, or the
 * `@KafkaConsumerController()` composite). It turns ANY failure of a handler, or of its pipes, guards and
 * interceptors, into a dead-letter record on `<topic>.dlq`, then completes normally so the offset
 * is committed and the partition moves on.
 *
 * Why: in Nest 12 an error that escapes an event handler reaches kafkajs, which retries and then
 * restarts the consumer on the SAME offset, so one poison message blocks its partition forever
 * (nest-distributed §5.5).
 *
 * - The returned observable EMITS once (`null`). `ServerKafka` awaits it with `lastValueFrom`, so
 *   `EMPTY` would fail with `EmptyError` and be treated as a handler error.
 * - `KafkaRetriableException` is rethrown on purpose: it is the explicit "let kafkajs retry" signal.
 * - If the dead-letter publish itself fails (broker unavailable), the ORIGINAL error is rethrown so
 *   kafkajs redelivers the message later. Nothing is lost; at worst it is processed twice, which
 *   handlers tolerate by deduplicating on the envelope id.
 * - Non-Kafka contexts are rethrown untouched.
 * - Transient failures reach it only after `KafkaRetryInterceptor` (applied by
 *   `@KafkaConsumerController()`) has retried them; replay the dead-letter topic with
 *   `replayDeadLetters` (`scripts/kafka-dlq-replay.mjs`) once the cause is fixed.
 */
@Catch()
export class KafkaDeadLetterFilter implements RpcExceptionFilter<unknown> {
  private readonly logger = new Logger(KafkaDeadLetterFilter.name);

  catch(exception: unknown, host: ArgumentsHost): Observable<null> {
    const context = host.getType() === 'rpc' ? host.switchToRpc().getContext<unknown>() : undefined;
    if (!(context instanceof KafkaContext) || exception instanceof KafkaRetriableException) {
      return throwError(() => exception);
    }
    return defer(() => this.deadLetter(context, exception)).pipe(map(() => null));
  }

  private async deadLetter(context: KafkaContext, exception: unknown): Promise<void> {
    const source = `${context.getTopic()}[${context.getPartition()}]@${context.getMessage().offset}`;
    try {
      const record = await sendToDeadLetter(context, exception);
      const summary = `Dead-lettered ${source} to ${record.topic} (${errorTypeOf(exception)}): ${exception instanceof Error ? exception.message : String(exception)}`;
      // A rejected record (4xx-class, e.g. INVALID_EVENT) is a producer bug, not an outage here.
      if (isDomainException(exception) && exception.httpStatus < HttpStatus.INTERNAL_SERVER_ERROR) {
        this.logger.warn(summary);
      } else {
        this.logger.error(summary, exception instanceof Error ? exception.stack : undefined);
      }
    } catch (publishError) {
      this.logger.error(
        `Could not dead-letter ${source}; leaving it for redelivery: ${String(publishError)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
      throw exception;
    }
  }
}
