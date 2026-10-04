import { computeBackoffDelay, getContextType, isDomainException } from '@app/common';
import {
  type CallHandler,
  type ExecutionContext,
  HttpStatus,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { KafkaContext, KafkaRetriableException } from '@nestjs/microservices';
import { type Observable, retry, throwError, timer } from 'rxjs';
import { z } from 'zod';
import { errorTypeOf } from './dead-letter.js';

/** Bounded in-process retry of a failing Kafka handler (`KafkaRetryInterceptor`). */
export interface KafkaRetryOptions {
  /** Total attempts, the first included. `1` disables retries. */
  readonly attempts: number;
  /** Delay before the first retry. */
  readonly minDelayMs: number;
  /** Upper bound of any delay (exponential backoff with full jitter in between). */
  readonly maxDelayMs: number;
}

/**
 * 4 attempts, at most 0.25 s + 0.5 s + 1 s between them. The whole budget must stay far below the
 * consumer's `sessionTimeout` (30 s): Nest's `eachMessage` never heartbeats while a handler runs.
 */
export const DEFAULT_KAFKA_RETRY_OPTIONS: KafkaRetryOptions = {
  attempts: 4,
  minDelayMs: 250,
  maxDelayMs: 2_000,
};

/**
 * Whether a handler failure is worth retrying in-process: infrastructure errors (driver,
 * connection, timeout) and 5xx-class `DomainException`s are; a 4xx-class `DomainException`
 * (`InvalidEventException`, validation, not found) or a `ZodError` would fail the same way again,
 * so it goes straight to the dead-letter topic. `KafkaRetriableException` is not retried here
 * either: it is the explicit "let kafkajs redeliver" signal that `KafkaDeadLetterFilter` rethrows.
 */
export function isRetriableKafkaHandlerError(error: unknown): boolean {
  if (error instanceof KafkaRetriableException) return false;
  if (error instanceof z.core.$ZodError) return false;
  if (isDomainException(error)) return error.httpStatus >= HttpStatus.INTERNAL_SERVER_ERROR;
  return true;
}

/**
 * Retries a failing Kafka handler (pipes included) a few times with backoff before the error
 * reaches `KafkaDeadLetterFilter`, so a short Cassandra, Postgres or Redis blip does not move every
 * message processed meanwhile to `<topic>.dlq`. Re-subscribing to `next.handle()` re-runs the
 * pipes and the handler; consumers are idempotent (deduplicated on the envelope id), so a partly
 * applied attempt is safe to repeat.
 *
 * Applied by `@KafkaConsumerController()` inside `KafkaContextInterceptor`, so every attempt shares
 * one nestjs-cls context. A no-op for non-Kafka contexts.
 */
export class KafkaRetryInterceptor implements NestInterceptor {
  private readonly logger = new Logger(KafkaRetryInterceptor.name);
  private readonly options: KafkaRetryOptions;

  constructor(options: Partial<KafkaRetryOptions> = {}) {
    this.options = { ...DEFAULT_KAFKA_RETRY_OPTIONS, ...options };
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const retries = Math.max(0, Math.floor(this.options.attempts) - 1);
    if (retries === 0 || getContextType(context) !== 'rpc') return next.handle();
    const kafka = context.switchToRpc().getContext<unknown>();
    if (!(kafka instanceof KafkaContext)) return next.handle();

    const source = `${kafka.getTopic()}[${kafka.getPartition()}]@${kafka.getMessage().offset}`;
    return next.handle().pipe(
      retry({
        count: retries,
        delay: (error: unknown, retryCount: number) => {
          if (!isRetriableKafkaHandlerError(error)) return throwError(() => error);
          const delayMs = computeBackoffDelay(retryCount, this.options);
          this.logger.warn(
            `Retrying ${source} in ${delayMs} ms (attempt ${retryCount + 1}/${retries + 1}) after ${errorTypeOf(error)}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return timer(delayMs);
        },
      }),
    );
  }
}
