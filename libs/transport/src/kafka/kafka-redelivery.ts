import { KafkaRetriableException } from '@nestjs/microservices';

/**
 * The error a consumer hands back to kafkajs when it wants the message redelivered: a
 * `KafkaRetriableException` with the same message and the original as `cause`. kafkajs 2.2.4's
 * consumer retrier gives up at once on an error named `TypeError`, `RangeError`, `ReferenceError`
 * or `SyntaxError`, or one with `retriable: false`, and the consumer then disconnects for good. It
 * retries this one, re-running the uncommitted message, and once its retries run out it restarts
 * the consumer (`KafkaJSNumberOfRetriesExceeded`), which redelivers the message again. A
 * `KafkaRetriableException` is returned as is. Internal: not exported from the package.
 */
export function toKafkaRedelivery(error: unknown): KafkaRetriableException {
  if (error instanceof KafkaRetriableException) return error;
  // RpcException takes no options: the original rides along as `cause` for the logs.
  return Object.assign(
    new KafkaRetriableException(error instanceof Error ? error.message : String(error)),
    { cause: error },
  );
}
