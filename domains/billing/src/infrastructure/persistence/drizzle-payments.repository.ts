import { Injectable } from '@nestjs/common';
import type { CursorPage } from '@platform/common';
import {
  type DrizzleTransactionalAdapter,
  decodeIdCursor,
  inUnitOfWork,
  keysetFetchLimit,
  keysetOrder,
  keysetPage,
  TransactionHost,
} from '@platform/database';
import { and, eq, lt, or } from 'drizzle-orm';
import { isNil } from 'lodash-es';
import type {
  CreatePaymentResult,
  ListPaymentsCriteria,
  PaymentsRepository,
} from '../../application/repositories/payments.repository.js';
import { PaymentConcurrentlyModifiedException } from '../../domain/billing.errors.js';
import type { Payment } from '../../domain/payment.aggregate.js';
import { type BillingSchema, payments } from './billing.schema.js';
import { fromPaymentRow, toPaymentRow } from './payment-row.mapper.js';

/**
 * Payments on the runtime pool under RLS. Every method runs through `inUnitOfWork`: it joins the
 * open unit of work (`@Transactional()`), or opens its own with the principal's RLS context. No
 * pool handle and no pool-bound prepared statements: a statement outside a transaction would carry
 * no context. Every query carries `tenant_id` (a router query to one shard on Citus).
 */
@Injectable()
export class DrizzlePaymentsRepository implements PaymentsRepository {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<BillingSchema>>,
  ) {}

  create(payment: Payment): Promise<CreatePaymentResult> {
    const row = toPaymentRow(payment);
    return inUnitOfWork(this.txHost, async (tx) => {
      // The unique (tenant_id, user_id, idempotency_key) index turns a replayed key into a no-op.
      const [inserted] = await tx
        .insert(payments)
        .values(row)
        .onConflictDoNothing({
          target: [payments.tenantId, payments.userId, payments.idempotencyKey],
        })
        .returning();
      if (inserted !== undefined) return { payment: fromPaymentRow(inserted), created: true };

      if (isNil(row.idempotencyKey)) {
        throw new Error(`Payment ${row.id} was not inserted although it has no idempotency key`);
      }
      const [existing] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.tenantId, row.tenantId),
            eq(payments.userId, row.userId),
            eq(payments.idempotencyKey, row.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing === undefined) {
        // The conflicting row was deleted in between: extremely unlikely, safe to retry.
        throw new PaymentConcurrentlyModifiedException(row.id);
      }
      return { payment: fromPaymentRow(existing), created: false };
    });
  }

  findById(tenantId: string, id: string): Promise<Payment | null> {
    return inUnitOfWork(this.txHost, async (tx) => {
      const [row] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.tenantId, tenantId), eq(payments.id, id)))
        .limit(1);
      return row === undefined ? null : fromPaymentRow(row);
    });
  }

  findForCheckoutSession(ref: {
    tenantId: string;
    paymentId: string | null;
    sessionId: string;
  }): Promise<Payment | null> {
    const bySession = eq(payments.stripeCheckoutSessionId, ref.sessionId);
    return inUnitOfWork(this.txHost, async (tx) => {
      // tenant_id equality first: FOR UPDATE needs the distribution column on Citus (sharding §2.1.6).
      const rows = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.tenantId, ref.tenantId),
            ref.paymentId === null ? bySession : or(eq(payments.id, ref.paymentId), bySession),
          ),
        )
        .limit(2)
        .for('update');
      const row = rows.find((r) => r.stripeCheckoutSessionId === ref.sessionId) ?? rows[0];
      return row === undefined ? null : fromPaymentRow(row);
    });
  }

  async save(payment: Payment): Promise<void> {
    const s = payment.toSnapshot();
    await inUnitOfWork(this.txHost, async (tx) => {
      const updated = await tx
        .update(payments)
        .set({
          amountTotal: s.amountTotal,
          currency: s.currency,
          status: s.status,
          stripeCheckoutSessionId: s.stripeCheckoutSessionId,
          stripePaymentIntentId: s.stripePaymentIntentId,
          paidAt: s.paidAt,
          updatedAt: s.updatedAt,
          version: s.version + 1,
        })
        .where(
          and(
            eq(payments.tenantId, s.tenantId),
            eq(payments.id, s.id),
            eq(payments.version, s.version),
          ),
        )
        .returning({ id: payments.id });
      // A stale version and a row the policies hide (another user's, unelevated) both match 0
      // rows. Thrown inside the unit of work, so it rolls back.
      if (updated.length === 0) throw new PaymentConcurrentlyModifiedException(s.id);
    });
    payment.markPersisted();
  }

  async list(criteria: ListPaymentsCriteria): Promise<CursorPage<Payment>> {
    // Decoded (and validated: a forged cursor is a 422, never SQL) before the unit of work opens.
    const { tenantId, userId, cursor } = criteria;
    const cursorId = isNil(cursor) || cursor === '' ? undefined : decodeIdCursor(cursor).id;
    const limit = keysetFetchLimit(criteria.limit); // + 1 look-ahead row → is there a next page?
    // Keyset pages, newest first (uuidv7 ids = time order), always inside one tenant (router query
    // on Citus): payments_tenant_id_user_id_id_idx for a user, the (tenant_id, id) PK for the tenant.
    const rows = await inUnitOfWork(this.txHost, (tx) =>
      tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.tenantId, tenantId),
            userId === undefined ? undefined : eq(payments.userId, userId),
            cursorId === undefined ? undefined : lt(payments.id, cursorId),
          ),
        )
        .orderBy(keysetOrder(payments.id))
        .limit(limit),
    );
    return keysetPage(rows.map(fromPaymentRow), criteria.limit);
  }
}
