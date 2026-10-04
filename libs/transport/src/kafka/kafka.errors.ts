import {
  DomainValidationException,
  type DomainValidationExceptionOptions,
  type IssueLike,
  toValidationIssues,
} from '@app/common';
import { KAFKA_ERROR_CODES } from './kafka.constants.js';

/**
 * A Kafka record (or a record about to be published) that does not match its topic's envelope
 * schema. It is a `DomainValidationException` (422, `code: 'INVALID_EVENT'`) so it renders like any
 * other validation error. A consumer must never retry it: `KafkaDeadLetterFilter` moves the
 * record to `<topic>.dlq` and commits the offset.
 */
export class InvalidEventException extends DomainValidationException {
  constructor(message = 'Invalid event', options?: DomainValidationExceptionOptions) {
    super(message, { ...options, code: options?.code ?? KAFKA_ERROR_CODES.INVALID_EVENT });
  }

  /** Builds the exception from zod issues, recording the topic in `details`. */
  static forTopic(
    topic: string,
    issues: readonly IssueLike[],
    options?: Omit<DomainValidationExceptionOptions, 'issues'>,
  ): InvalidEventException {
    return new InvalidEventException(`Invalid "${topic}" event`, {
      ...options,
      details: { ...options?.details, topic },
      issues: toValidationIssues(issues),
    });
  }
}
