import { describe, expect, it } from 'vitest';
import { BillingErrorCode, STRIPE_SIGNATURE_HEADER } from './billing.constants.js';

describe('BillingErrorCode', () => {
  it('owns the Stripe adapter codes too, with their published values', () => {
    expect(BillingErrorCode).toMatchObject({
      INVALID_WEBHOOK_SIGNATURE: 'INVALID_WEBHOOK_SIGNATURE',
      INVALID_WEBHOOK_PAYLOAD: 'INVALID_WEBHOOK_PAYLOAD',
      PAYMENT_REQUEST_INVALID: 'PAYMENT_REQUEST_INVALID',
      PAYMENT_DECLINED: 'PAYMENT_DECLINED',
      IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
      PAYMENT_PROVIDER_RATE_LIMITED: 'PAYMENT_PROVIDER_RATE_LIMITED',
      PAYMENT_PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
    });
  });

  it('uses every key as its own value (codes are public API: never rename)', () => {
    for (const [key, value] of Object.entries(BillingErrorCode)) expect(value).toBe(key);
  });
});

describe('STRIPE_SIGNATURE_HEADER', () => {
  it('is the lower-case header Stripe signs webhooks with (Node lower-cases incoming names)', () => {
    expect(STRIPE_SIGNATURE_HEADER).toBe('stripe-signature');
  });
});
