import { describe, expect, it } from 'vitest';
import { BILLING_LOG_REDACT_PATHS } from './billing-log-redaction.js';

describe('BILLING_LOG_REDACT_PATHS', () => {
  it('masks the Stripe-Signature request header, under the name Stripe sends it by', () => {
    // The apps' e2e guards compare their redact paths against this list, so emptying it would pass them.
    expect(BILLING_LOG_REDACT_PATHS).toContain('req.headers["stripe-signature"]');
    expect(BILLING_LOG_REDACT_PATHS).toEqual(['req.headers["stripe-signature"]']);
  });
});
