import {
  type CallHandler,
  type ExecutionContext,
  HttpStatus,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { KafkaContext, KafkaRetriableException } from '@nestjs/microservices';
import {
  computeBackoffDelay,
  getContextType,
  isDomainException,
  OperationTimeoutException,
} from '@platform/common';
import { noop } from 'lodash-es';
import { Observable, retry, throwError, timer } from 'rxjs';
import { z } from 'zod';
import { errorTypeOf } from './dead-letter.js';
import { KAFKA_HEARTBEAT_INTERVAL_MS } from './kafka.options.js';
import { recordKafkaRetry } from './kafka-metrics.js';

/**
 * What a spent budget becomes: `'dead-letter'` lets the `OperationTimeoutException` reach
 * `KafkaDeadLetterFilter` (as a transient failure after its retries); `'redeliver'` throws
 * `KafkaRetriableException`, so kafkajs redelivers the message and it is never dead-lettered.
 */
export type KafkaBudgetExceededAction = 'dead-letter' | 'redeliver';

/** Bounded in-process retry of a failing Kafka handler (`KafkaRetryInterceptor`). */
export interface KafkaRetryOptions {
  /** Total attempts, the first included. `1` disables retries. */
  readonly attempts: number;
  /** Delay before the first retry. */
  readonly minDelayMs: number;
  /** Upper bound of any delay (exponential backoff with full jitter in between). */
  readonly maxDelayMs: number;
  /**
   * One deadline for all in-process work of one message: every attempt and every delay. When it
   * ends the wait is abandoned (the running attempt is not cancelled) and no further attempt
   * starts. Plus the dead-letter send deadline and 10 s, it must stay within the consumer's
   * `rebalanceTimeout` (`kafka.options.spec.ts` checks every consumer controller).
   */
  readonly budgetMs: number;
  /** What a spent budget becomes. */
  readonly onBudgetExceeded: KafkaBudgetExceededAction;
}

/**
 * 4 attempts, at most 0.25 s + 0.5 s + 1 s between them, all within 40 s. The budget, not the
 * attempt count, bounds a message: one slow attempt (a Cassandra or Stripe request near its own
 * timeout) may use most of it, and the consumer heartbeats meanwhile.
 */
export const DEFAULT_KAFKA_RETRY_OPTIONS: KafkaRetryOptions = {
  attempts: 4,
  minDelayMs: 250,
  maxDelayMs: 2_000,
  budgetMs: 40_000,
  onBudgetExceeded: 'dead-letter',
};

/**
 * kafkajs' heartbeat rejections that mean the member must rejoin (its `isRebalancing`). kafkajs
 * commits the resolved offsets and reports the rebalance itself after the message, so further
 * heartbeats in between are pointless.
 */
const REBALANCE_ERROR_TYPES: ReadonlySet<unknown> = new Set([
  'REBALANCE_IN_PROGRESS',
  'NOT_COORDINATOR_FOR_GROUP',
  'ILLEGAL_GENERATION',
]);

const isRebalanceError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  REBALANCE_ERROR_TYPES.has((error as { type?: unknown }).type);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
 * One message's in-process work is bounded and heartbeats while it runs (B3-6), because kafkajs
 * heartbeats only between messages:
 * - **Budget.** Every attempt and every delay share one deadline, `budgetMs` (40 s). When it ends
 *   the wait is abandoned with an `OperationTimeoutException` naming the budget and no further
 *   attempt starts; `onBudgetExceeded: 'redeliver'` throws `KafkaRetriableException` instead. The
 *   abandoned attempt may still finish next to the redelivery: handlers are idempotent.
 * - **Heartbeat.** `KafkaContext.getHeartbeat()` is called at the start and then every
 *   `KAFKA_HEARTBEAT_INTERVAL_MS` (3 s) until the work ends. A rejection changes no outcome (logged
 *   at debug); after a rebalance-type rejection the heartbeats stop, and kafkajs rejoins after the
 *   message. A context without the function (a unit fake) skips heartbeats.
 * With the dead-letter send deadline (5 s), one message holds its consumer for at most 45 s, well
 * within the session (heartbeats) and the 60 s rebalance timeout.
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
    if (getContextType(context) !== 'rpc') return next.handle();
    const kafka = context.switchToRpc().getContext<unknown>();
    if (!(kafka instanceof KafkaContext)) return next.handle();

    const source = `${kafka.getTopic()}[${kafka.getPartition()}]@${kafka.getMessage().offset}`;
    const retries = Math.max(0, Math.floor(this.options.attempts) - 1);
    let lastError: unknown;
    const work =
      retries === 0
        ? next.handle()
        : next.handle().pipe(
            retry({
              count: retries,
              delay: (error: unknown, retryCount: number) => {
                if (!isRetriableKafkaHandlerError(error)) return throwError(() => error);
                lastError = error;
                const delayMs = computeBackoffDelay(retryCount, this.options);
                this.logger.warn(
                  `Retrying ${source} in ${delayMs} ms (attempt ${retryCount + 1}/${retries + 1}) after ${errorTypeOf(error)}: ${messageOf(error)}`,
                );
                recordKafkaRetry(kafka.getTopic());
                return timer(delayMs);
              },
            }),
          );

    return new Observable<unknown>((subscriber) => {
      const stopHeartbeat = this.startHeartbeat(kafka, source);
      const budget = setTimeout(
        () => subscriber.error(this.budgetExceeded(source, lastError)),
        this.options.budgetMs,
      );
      budget.unref();
      const subscription = work.subscribe({
        next: (value) => subscriber.next(value),
        error: (error: unknown) => subscriber.error(error),
        complete: () => subscriber.complete(),
      });
      // Runs on completion, on error (the budget's too) and on unsubscribe: unsubscribing the
      // retry chain cancels a pending delay, so no attempt starts after the budget.
      return () => {
        clearTimeout(budget);
        stopHeartbeat();
        subscription.unsubscribe();
      };
    });
  }

  /** Heartbeats now and every interval; returns the stop function. */
  private startHeartbeat(kafka: KafkaContext, source: string): () => void {
    const heartbeat: unknown = kafka.getHeartbeat();
    if (typeof heartbeat !== 'function') return noop;
    const interval = setInterval(() => beat(), KAFKA_HEARTBEAT_INTERVAL_MS);
    interval.unref();
    const stop = () => clearInterval(interval);
    const failed = (error: unknown): void => {
      this.logger.debug(`Heartbeat during ${source} failed: ${messageOf(error)}`);
      if (isRebalanceError(error)) stop();
    };
    const beat = (): void => {
      try {
        Promise.resolve((heartbeat as () => unknown)()).catch(failed);
      } catch (error) {
        failed(error);
      }
    };
    beat();
    return stop;
  }

  private budgetExceeded(source: string, lastError: unknown): Error {
    const { budgetMs, onBudgetExceeded } = this.options;
    const timeout = new OperationTimeoutException(
      `${source} spent its in-process budget of ${budgetMs} ms (KafkaRetryInterceptor)`,
      { details: { budgetMs }, cause: lastError },
    );
    this.logger.warn(
      `${timeout.message}; the running attempt is abandoned and the message goes to ${onBudgetExceeded === 'redeliver' ? 'redelivery' : 'the dead-letter filter'}`,
    );
    if (onBudgetExceeded === 'dead-letter') return timeout;
    // RpcException takes no options: the timeout rides along as `cause` for the logs.
    return Object.assign(new KafkaRetriableException(timeout.message), { cause: timeout });
  }
}
