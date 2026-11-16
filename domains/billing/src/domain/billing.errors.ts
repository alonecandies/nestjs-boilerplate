import {
  DomainConflictException,
  DomainValidationException,
  EntityNotFoundException,
  ExternalServiceException,
  PermissionDeniedException,
  type ValidationIssue,
} from '@platform/common';
import { BillingErrorCode } from '../billing.constants.js';

/*
 * Billing errors: DomainException subclasses with stable codes. Transports map them (REST
 * problem+json, gRPC status + `x-error-code` trailer, GraphQL `extensions.code`). Messages never
 * contain Stripe secrets or customer emails.
 */

/** 404 — no payment with this id. */
export class PaymentNotFoundException extends EntityNotFoundException {
  constructor(paymentId: string) {
    super('Payment', paymentId, { code: BillingErrorCode.PAYMENT_NOT_FOUND });
  }
}

/** 409 — an `Idempotency-Key` was replayed with a different request (price or quantity). */
export class IdempotencyKeyReusedException extends DomainConflictException {
  constructor() {
    super('This Idempotency-Key was already used for a different checkout request', {
      code: BillingErrorCode.IDEMPOTENCY_KEY_REUSED,
    });
  }
}

/** 409 — optimistic lock: the payment was modified concurrently; the client may retry. */
export class PaymentConcurrentlyModifiedException extends DomainConflictException {
  constructor(paymentId: string) {
    super('The payment was modified concurrently, please retry', {
      code: BillingErrorCode.PAYMENT_CONCURRENTLY_MODIFIED,
      details: { paymentId },
    });
  }
}

/** 409 — the payment is already bound to another Checkout Session. */
export class CheckoutSessionMismatchException extends DomainConflictException {
  constructor(paymentId: string) {
    super('The payment is already bound to another checkout session', {
      code: BillingErrorCode.CHECKOUT_SESSION_MISMATCH,
      details: { paymentId },
    });
  }
}

/** 502 — Stripe answered without a hosted Checkout URL. */
export class CheckoutUrlMissingException extends ExternalServiceException {
  constructor() {
    super('The payment provider returned no checkout URL', {
      code: BillingErrorCode.CHECKOUT_URL_MISSING,
    });
  }
}

/** 409 — a replayed checkout request found its session `complete` or `expired`: never create a second one. */
export class CheckoutSessionClosedException extends DomainConflictException {
  constructor(paymentId: string, sessionStatus: string) {
    super(`The Checkout Session of payment ${paymentId} is ${sessionStatus}`, {
      code: BillingErrorCode.CHECKOUT_SESSION_CLOSED,
      details: { paymentId, sessionStatus },
    });
  }
}

/** 422 — aggregate invariant violated (e.g. a non-positive quantity reaching the domain). */
export class InvalidPaymentException extends DomainValidationException {
  constructor(issues: readonly ValidationIssue[]) {
    super('Invalid payment', { code: BillingErrorCode.INVALID_PAYMENT, issues });
  }
}

/** 403 — the request names a tenant (or user) other than the caller's principal. */
export class TenantMismatchException extends PermissionDeniedException {
  constructor() {
    super('The request does not belong to your active workspace', {
      code: BillingErrorCode.TENANT_MISMATCH,
    });
  }
}
