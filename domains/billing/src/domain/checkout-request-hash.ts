import { sha256Hex } from '@platform/common';
import { toLower, trim } from 'lodash-es';

/** The checkout fields that reach Stripe (ledger design S-2). */
export interface CheckoutRequestShape {
  priceId: string;
  quantity: number;
  customerEmail: string;
  successUrl?: string | undefined;
  cancelUrl?: string | undefined;
}

/**
 * sha256 hex of the normalized checkout request, stored on the payment so a replayed
 * Idempotency-Key with ANY different field (not just price and quantity) is a 409. Absent URLs hash
 * as '' (the configured defaults apply later and are the same for every replay).
 */
export function checkoutRequestHash(request: CheckoutRequestShape): string {
  return sha256Hex(
    JSON.stringify([
      trim(request.priceId),
      request.quantity,
      toLower(trim(request.customerEmail)),
      request.successUrl ?? '',
      request.cancelUrl ?? '',
    ]),
  );
}
