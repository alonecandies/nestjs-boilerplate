import type { CursorPage } from '@platform/common';
import type { Payment } from '../../domain/payment.aggregate.js';

export interface CreatePaymentResult {
  payment: Payment;
  /** `false` when the user's `Idempotency-Key` already existed in the tenant: `payment` is the stored one. */
  created: boolean;
}

export interface ListPaymentsCriteria {
  /** Always set: listings never cross a tenant (sharding design §2.1.5). */
  tenantId: string;
  /** Omitted = every payment of the tenant (`billing:read-all` at the edge). */
  userId?: string | undefined;
  limit: number;
  /** Opaque keyset cursor (`nextCursor` of the previous page); absent = first page. */
  cursor?: string | undefined;
}

/**
 * Payment persistence (implemented by `DrizzlePaymentsRepository`). Methods join the active
 * `@Transactional()` transaction when there is one.
 */
export abstract class PaymentsRepository {
  /**
   * Inserts a new payment. When `idempotencyKey` is set and the user already has a payment with
   * that key in the tenant (unique per (tenant, user, key)), nothing is inserted and the existing payment is returned (`created: false`).
   */
  abstract create(payment: Payment): Promise<CreatePaymentResult>;

  /** Within `tenantId`: another tenant's payment is `null`. */
  abstract findById(tenantId: string, id: string): Promise<Payment | null>;

  /**
   * Loads the payment for a Stripe Checkout Session with a row lock (`FOR UPDATE`) — by our
   * `client_reference_id` (= payment id) when Stripe echoes it, else by the session id. Call it
   * inside a transaction. Within `tenantId` only.
   */
  abstract findForCheckoutSession(ref: {
    tenantId: string;
    paymentId: string | null;
    sessionId: string;
  }): Promise<Payment | null>;

  /**
   * Persists the aggregate's mutable state with an optimistic lock on `version`.
   * @throws PaymentConcurrentlyModifiedException the row changed since it was loaded
   */
  abstract save(payment: Payment): Promise<void>;

  /**
   * One page, newest first (uuidv7 order), resuming after `cursor` (keyset: `id < $cursor`).
   * `nextCursor` is `null` on the last page.
   * @throws DomainValidationException (`INVALID_CURSOR`) a cursor this API did not issue
   */
  abstract list(criteria: ListPaymentsCriteria): Promise<CursorPage<Payment>>;
}
