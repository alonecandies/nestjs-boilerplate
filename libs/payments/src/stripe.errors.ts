import {
  BusinessRuleViolationException,
  DomainConflictException,
  type DomainException,
  DomainValidationException,
  ExternalServiceException,
  ServiceUnavailableException,
} from '@app/common';
import Stripe from 'stripe';

/** Stable error codes emitted by `@app/payments` (part of the public API — never rename). */
export const PaymentErrorCode = {
  INVALID_WEBHOOK_SIGNATURE: 'INVALID_WEBHOOK_SIGNATURE',
  INVALID_WEBHOOK_PAYLOAD: 'INVALID_WEBHOOK_PAYLOAD',
  PAYMENT_REQUEST_INVALID: 'PAYMENT_REQUEST_INVALID',
  PAYMENT_DECLINED: 'PAYMENT_DECLINED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  PAYMENT_PROVIDER_RATE_LIMITED: 'PAYMENT_PROVIDER_RATE_LIMITED',
  PAYMENT_PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
} as const;
export type PaymentErrorCode = (typeof PaymentErrorCode)[keyof typeof PaymentErrorCode];

/**
 * Translates a Stripe SDK error into the platform's `DomainException` vocabulary so billing code
 * never leaks `Stripe.errors.*` (or HTTP concerns) upward. 4xx-class Stripe errors carry
 * client-safe messages (e.g. "No such price"); 5xx-class ones get a generic message because
 * `DomainException` messages are rendered verbatim — the original error stays in `cause` for logs.
 * Non-Stripe values are returned untouched (caller rethrows them).
 */
export function toPaymentDomainException(error: unknown): DomainException | undefined {
  if (!(error instanceof Stripe.errors.StripeError)) return undefined;
  const stripeRequestId = error.requestId;
  const details = stripeRequestId === undefined ? undefined : { stripeRequestId };

  if (error instanceof Stripe.errors.StripeIdempotencyError) {
    return new DomainConflictException('The idempotency key was already used for another request', {
      code: PaymentErrorCode.IDEMPOTENCY_KEY_REUSED,
      cause: error,
      details,
    });
  }
  if (error instanceof Stripe.errors.StripeCardError) {
    return new BusinessRuleViolationException(error.message, {
      code: PaymentErrorCode.PAYMENT_DECLINED,
      cause: error,
      details: { ...details, declineCode: error.decline_code },
    });
  }
  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    return new DomainValidationException(error.message, {
      code: PaymentErrorCode.PAYMENT_REQUEST_INVALID,
      cause: error,
      details,
      issues: [
        {
          path: error.param ?? '',
          message: error.message,
          ...(error.code ? { code: error.code } : {}),
        },
      ],
    });
  }
  if (error instanceof Stripe.errors.StripeRateLimitError) {
    return new ServiceUnavailableException('The payment provider is busy, please retry shortly', {
      code: PaymentErrorCode.PAYMENT_PROVIDER_RATE_LIMITED,
      cause: error,
      details,
    });
  }
  // Authentication/permission (our misconfiguration), API and connection errors: upstream failure.
  return new ExternalServiceException('The payment provider request failed', {
    code: PaymentErrorCode.PAYMENT_PROVIDER_ERROR,
    cause: error,
    details,
  });
}
