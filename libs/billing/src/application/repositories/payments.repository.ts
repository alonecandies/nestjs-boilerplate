import type { Payment } from '../../domain/payment.aggregate.js';

export interface CreatePaymentResult {
  payment: Payment;
  /** `false` when the user's `Idempotency-Key` already existed: `payment` is the stored one. */
  created: boolean;
}

export interface ListPaymentsCriteria {
  /** Omitted = every user's payments (admin listing). */
  userId?: string | undefined;
  limit: number;
}

/**
 * Payment persistence (implemented by `DrizzlePaymentsRepository`). Methods join the active
 * `@Transactional()` transaction when there is one.
 */
export abstract class PaymentsRepository {
  /**
   * Inserts a new payment. When `idempotencyKey` is set and the user already has a payment with
   * that key, nothing is inserted and the existing payment is returned (`created: false`).
   */
  abstract create(payment: Payment): Promise<CreatePaymentResult>;

  abstract findById(id: string): Promise<Payment | null>;

  /**
   * Loads the payment for a Stripe Checkout Session with a row lock (`FOR UPDATE`) — by our
   * `client_reference_id` (= payment id) when Stripe echoes it, else by the session id. Call it
   * inside a transaction.
   */
  abstract findForCheckoutSession(ref: {
    paymentId: string | null;
    sessionId: string;
  }): Promise<Payment | null>;

  /**
   * Persists the aggregate's mutable state with an optimistic lock on `version`.
   * @throws PaymentConcurrentlyModifiedException the row changed since it was loaded
   */
  abstract save(payment: Payment): Promise<void>;

  /** Newest first (uuidv7 order). */
  abstract list(criteria: ListPaymentsCriteria): Promise<Payment[]>;
}
