import {
  BusinessRuleViolationException,
  DomainConflictException,
  ExternalServiceException,
  ServiceUnavailableException,
} from '@app/common';
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { toPaymentDomainException } from './stripe.errors.js';

describe('toPaymentDomainException', () => {
  it('returns undefined for non-Stripe errors', () => {
    expect(toPaymentDomainException(new Error('x'))).toBeUndefined();
    expect(toPaymentDomainException('x')).toBeUndefined();
  });

  it('maps idempotency conflicts to 409', () => {
    const mapped = toPaymentDomainException(
      new Stripe.errors.StripeIdempotencyError({ message: 'Keys for idempotent requests…' }),
    );
    expect(mapped).toBeInstanceOf(DomainConflictException);
    expect(mapped?.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('maps card declines to a business rule violation with the decline code', () => {
    const mapped = toPaymentDomainException(
      new Stripe.errors.StripeCardError({
        message: 'Your card was declined.',
        decline_code: 'insufficient_funds',
        type: 'card_error',
      }),
    );
    expect(mapped).toBeInstanceOf(BusinessRuleViolationException);
    expect(mapped).toMatchObject({
      code: 'PAYMENT_DECLINED',
      details: { declineCode: 'insufficient_funds' },
    });
  });

  it('maps rate limiting to 503 and keeps the Stripe request id', () => {
    const mapped = toPaymentDomainException(
      new Stripe.errors.StripeRateLimitError({
        message: 'Too many requests',
        headers: { 'request-id': 'req_42' },
        requestId: 'req_42',
      }),
    );
    expect(mapped).toBeInstanceOf(ServiceUnavailableException);
    expect(mapped?.details).toEqual({ stripeRequestId: 'req_42' });
  });

  it('maps authentication and API errors to a generic 502 (never leaks the SDK message)', () => {
    const mapped = toPaymentDomainException(
      new Stripe.errors.StripeAuthenticationError({ message: 'Invalid API Key provided: sk_…' }),
    );
    expect(mapped).toBeInstanceOf(ExternalServiceException);
    expect(mapped?.message).toBe('The payment provider request failed');
    expect(mapped?.cause).toBeInstanceOf(Stripe.errors.StripeAuthenticationError);
  });
});
