import { describe, expect, it } from 'vitest';
import { checkoutRequestHash } from './checkout-request-hash.js';

describe('checkoutRequestHash', () => {
  const base = { priceId: 'price_pro', quantity: 2, customerEmail: 'Buyer@Example.com' };

  it('is a sha256 hex that ignores price id padding and email case', () => {
    const hash = checkoutRequestHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      checkoutRequestHash({ ...base, priceId: ' price_pro ', customerEmail: 'buyer@example.com' }),
    ).toBe(hash);
  });

  it.each([
    ['quantity', { quantity: 3 }],
    ['price', { priceId: 'price_basic' }],
    ['email', { customerEmail: 'other@example.com' }],
    ['success URL', { successUrl: 'https://evil.test/ok' }],
    ['cancel URL', { cancelUrl: 'https://evil.test/no' }],
  ])('changes with the %s (ledger S-2: all five request fields count)', (_field, change) => {
    expect(checkoutRequestHash({ ...base, ...change })).not.toBe(checkoutRequestHash(base));
  });
});
