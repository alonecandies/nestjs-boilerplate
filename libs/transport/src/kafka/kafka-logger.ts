import { Logger } from '@nestjs/common';
import type { KafkaOptions } from '@nestjs/microservices';
import { logLevel } from 'kafkajs';
import { isEmpty, omit } from 'lodash-es';

/** kafkajs' `logCreator`, in the shape Nest's `KafkaOptions` (and kafkajs itself) accept. */
export type KafkaLogCreator = NonNullable<
  NonNullable<NonNullable<KafkaOptions['options']>['client']>['logCreator']
>;
type KafkaLogEntry = Parameters<ReturnType<KafkaLogCreator>>[0];

/**
 * kafkajs ERROR lines that describe a step of its own retry or reconnect loop, not a failure: the
 * operation is retried, and a final failure still surfaces (consumer `Crash`, a rejected `send()`,
 * a failing readiness check). One broker restart otherwise produced a burst of ERROR lines.
 */
const TRANSIENT_MESSAGES: readonly RegExp[] = [
  /^Connection error:/,
  /^Connection timeout/,
  /^Failed to connect to seed broker/,
  /^Failed to connect to broker, reconnecting/,
  /^Failed to send messages:/,
  /^Restarting the consumer in/,
  /^The coordinator is not aware of this member/,
  /^Offset out of range/,
];

/** Retriable broker answers that kafkajs logs as `Response <Api>(...)` before retrying. */
const TRANSIENT_RESPONSE_ERRORS =
  /coordinator is (loading|not available)|not the correct coordinator|rebalanc|no leader|not the leader|leadership election|timed out|not enough replicas/i;

/** True when an ERROR entry is a transient step that kafkajs retries on its own. */
export function isTransientKafkaLog(message: string, extra: Record<string, unknown>): boolean {
  if (TRANSIENT_MESSAGES.some((pattern) => pattern.test(message))) return true;
  return (
    message.startsWith('Response ') &&
    typeof extra['error'] === 'string' &&
    TRANSIENT_RESPONSE_ERRORS.test(extra['error'])
  );
}

const ERROR: number = logLevel.ERROR;
const WARN: number = logLevel.WARN;
const INFO: number = logLevel.INFO;

function messageOf(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return typeof value === 'string' ? value : String(value);
}

/**
 * kafkajs `logCreator` that writes through Nest's `Logger` (pino in the apps; context `KafkaJS`)
 * instead of kafkajs' own JSON console logger. Levels map ERROR → `error`, WARN → `warn`,
 * INFO → `log`, DEBUG → `debug`, except that ERROR entries of kafkajs' own retry and reconnect
 * loops (`isTransientKafkaLog`) are logged as `warn`.
 *
 * `createKafkaClientConfig` sets it, so it covers the consumer, the producer and the admin client
 * of `KafkaHealthIndicator` (which builds a plain `new Kafka()` that Nest's logger never reached).
 */
export function createKafkaLogCreator(logger: Logger = new Logger('KafkaJS')): KafkaLogCreator {
  return () =>
    ({ namespace, level, log }: KafkaLogEntry): void => {
      const message = messageOf(log.message);
      const extra = omit(log, ['message', 'timestamp', 'logger', 'stack']) as Record<
        string,
        unknown
      >;
      const stack = typeof log['stack'] === 'string' ? log['stack'] : undefined;
      const text = `[${namespace}] ${message}${isEmpty(extra) ? '' : ` ${JSON.stringify(extra)}`}`;
      // Nest and kafkajs each declare their own `logLevel` enum: compare plain numbers.
      const severity: number = level;
      if (severity <= ERROR) {
        if (isTransientKafkaLog(message, extra)) logger.warn(text);
        else if (stack === undefined) logger.error(text);
        else logger.error(text, stack);
      } else if (severity === WARN) {
        logger.warn(text);
      } else if (severity === INFO) {
        logger.log(text);
      } else {
        logger.debug(text);
      }
    };
}
