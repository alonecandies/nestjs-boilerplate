import { Injectable } from '@nestjs/common';
import type { CursorPage } from '@platform/common';
import {
  type DrizzleDB,
  type DrizzleTransactionalAdapter,
  decodeIdCursor,
  InjectDrizzle,
  keysetFetchLimit,
  keysetOrder,
  keysetPage,
  TransactionHost,
} from '@platform/database';
import { and, eq, lt, or, sql } from 'drizzle-orm';
import { isNil } from 'lodash-es';
import type {
  CreatePaymentResult,
  ListPaymentsCriteria,
  PaymentsRepository,
} from '../../application/repositories/payments.repository.js';
import { PaymentConcurrentlyModifiedException } from '../../domain/billing.errors.js';
import type { Payment } from '../../domain/payment.aggregate.js';
import { payments } from './billing.schema.js';
import { fromPaymentRow, toPaymentRow } from './payment-row.mapper.js';

/**
 * Read statements are prepared once on the pool handle (built in the constructor body, never in
 * a field initialiser — the injected handle is not assigned yet there). They run outside any
 * transaction; everything that writes or locks goes through `txHost.tx` and therefore joins the
 * active `@Transactional()` transaction.
 */
const prepareStatements = (db: DrizzleDB) => ({
  byId: db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.tenantId, sql.placeholder('tenantId')),
        eq(payments.id, sql.placeholder('id')),
      ),
    )
    .limit(1)
    .prepare('billing_payment_by_tenant_id'),
  // Keyset pages, newest first (uuidv7 ids = time order), always inside one tenant (router query
  // on Citus): payments_tenant_id_user_id_id_idx for a user, the (tenant_id, id) PK for the tenant.
  byUser: db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.tenantId, sql.placeholder('tenantId')),
        eq(payments.userId, sql.placeholder('userId')),
      ),
    )
    .orderBy(keysetOrder(payments.id))
    .limit(sql.placeholder('limit'))
    .prepare('billing_payments_by_tenant_user'),
  byUserAfter: db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.tenantId, sql.placeholder('tenantId')),
        eq(payments.userId, sql.placeholder('userId')),
        lt(payments.id, sql.placeholder('cursorId')),
      ),
    )
    .orderBy(keysetOrder(payments.id))
    .limit(sql.placeholder('limit'))
    .prepare('billing_payments_by_tenant_user_after'),
  byTenant: db
    .select()
    .from(payments)
    .where(eq(payments.tenantId, sql.placeholder('tenantId')))
    .orderBy(keysetOrder(payments.id))
    .limit(sql.placeholder('limit'))
    .prepare('billing_payments_by_tenant'),
  byTenantAfter: db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.tenantId, sql.placeholder('tenantId')),
        lt(payments.id, sql.placeholder('cursorId')),
      ),
    )
    .orderBy(keysetOrder(payments.id))
    .limit(sql.placeholder('limit'))
    .prepare('billing_payments_by_tenant_after'),
});

@Injectable()
export class DrizzlePaymentsRepository implements PaymentsRepository {
  private readonly statements: ReturnType<typeof prepareStatements>;

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactionalAdapter>,
    @InjectDrizzle() db: DrizzleDB,
  ) {
    this.statements = prepareStatements(db);
  }

  async create(payment: Payment): Promise<CreatePaymentResult> {
    const row = toPaymentRow(payment);
    // The unique (tenant_id, user_id, idempotency_key) index turns a replayed key into a no-op.
    const [inserted] = await this.txHost.tx
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
    const [existing] = await this.txHost.tx
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
  }

  async findById(tenantId: string, id: string): Promise<Payment | null> {
    const [row] = await this.statements.byId.execute({ tenantId, id });
    return row === undefined ? null : fromPaymentRow(row);
  }

  async findForCheckoutSession(ref: {
    tenantId: string;
    paymentId: string | null;
    sessionId: string;
  }): Promise<Payment | null> {
    const bySession = eq(payments.stripeCheckoutSessionId, ref.sessionId);
    // tenant_id equality first: FOR UPDATE needs the distribution column on Citus (sharding §2.1.6).
    const rows = await this.txHost.tx
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
  }

  async save(payment: Payment): Promise<void> {
    const s = payment.toSnapshot();
    const updated = await this.txHost.tx
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
    if (updated.length === 0) throw new PaymentConcurrentlyModifiedException(s.id);
    payment.markPersisted();
  }

  async list(criteria: ListPaymentsCriteria): Promise<CursorPage<Payment>> {
    // Decoded (and validated: a forged cursor is a 422, never SQL) before choosing the statement.
    const { tenantId, userId, cursor } = criteria;
    const cursorId = isNil(cursor) || cursor === '' ? undefined : decodeIdCursor(cursor).id;
    const limit = keysetFetchLimit(criteria.limit); // + 1 look-ahead row → is there a next page?
    const rows =
      userId === undefined
        ? cursorId === undefined
          ? await this.statements.byTenant.execute({ tenantId, limit })
          : await this.statements.byTenantAfter.execute({ tenantId, cursorId, limit })
        : cursorId === undefined
          ? await this.statements.byUser.execute({ tenantId, userId, limit })
          : await this.statements.byUserAfter.execute({ tenantId, userId, cursorId, limit });
    return keysetPage(rows.map(fromPaymentRow), criteria.limit);
  }
}
