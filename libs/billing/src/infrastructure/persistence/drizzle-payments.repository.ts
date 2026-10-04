import type { CursorPage } from '@app/common';
import {
  type DrizzleDB,
  type DrizzleTransactionalAdapter,
  decodeIdCursor,
  InjectDrizzle,
  keysetFetchLimit,
  keysetOrder,
  keysetPage,
  TransactionHost,
} from '@app/database';
import { Injectable } from '@nestjs/common';
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
    .where(eq(payments.id, sql.placeholder('id')))
    .limit(1)
    .prepare('billing_payment_by_id'),
  // Keyset pages, newest first (uuidv7 ids = time order). Per user: payments_user_id_id_idx
  // scanned backwards from `(user_id, $cursor)`; every user (admin): the primary key.
  byUser: db
    .select()
    .from(payments)
    .where(eq(payments.userId, sql.placeholder('userId')))
    .orderBy(keysetOrder(payments.id))
    .limit(sql.placeholder('limit'))
    .prepare('billing_payments_by_user'),
  byUserAfter: db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.userId, sql.placeholder('userId')),
        lt(payments.id, sql.placeholder('cursorId')),
      ),
    )
    .orderBy(keysetOrder(payments.id))
    .limit(sql.placeholder('limit'))
    .prepare('billing_payments_by_user_after'),
  all: db
    .select()
    .from(payments)
    .orderBy(keysetOrder(payments.id))
    .limit(sql.placeholder('limit'))
    .prepare('billing_payments_all'),
  allAfter: db
    .select()
    .from(payments)
    .where(lt(payments.id, sql.placeholder('cursorId')))
    .orderBy(keysetOrder(payments.id))
    .limit(sql.placeholder('limit'))
    .prepare('billing_payments_all_after'),
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
    // One round trip on the happy path; the unique (user_id, idempotency_key) index turns a replayed
    // key into a no-op instead of an error (NULL keys never conflict).
    const [inserted] = await this.txHost.tx
      .insert(payments)
      .values(row)
      .onConflictDoNothing({ target: [payments.userId, payments.idempotencyKey] })
      .returning();
    if (inserted !== undefined) return { payment: fromPaymentRow(inserted), created: true };

    if (isNil(row.idempotencyKey)) {
      throw new Error(`Payment ${row.id} was not inserted although it has no idempotency key`);
    }
    const [existing] = await this.txHost.tx
      .select()
      .from(payments)
      .where(and(eq(payments.userId, row.userId), eq(payments.idempotencyKey, row.idempotencyKey)))
      .limit(1);
    if (existing === undefined) {
      // The conflicting row was deleted in between: extremely unlikely, safe to retry.
      throw new PaymentConcurrentlyModifiedException(row.id);
    }
    return { payment: fromPaymentRow(existing), created: false };
  }

  async findById(id: string): Promise<Payment | null> {
    const [row] = await this.statements.byId.execute({ id });
    return row === undefined ? null : fromPaymentRow(row);
  }

  async findForCheckoutSession(ref: {
    paymentId: string | null;
    sessionId: string;
  }): Promise<Payment | null> {
    const bySession = eq(payments.stripeCheckoutSessionId, ref.sessionId);
    // One statement (BitmapOr over the PK and the unique session index) + row lock, so concurrent
    // deliveries of different events for one payment serialise.
    const rows = await this.txHost.tx
      .select()
      .from(payments)
      .where(ref.paymentId === null ? bySession : or(eq(payments.id, ref.paymentId), bySession))
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
      .where(and(eq(payments.id, s.id), eq(payments.version, s.version)))
      .returning({ id: payments.id });
    if (updated.length === 0) throw new PaymentConcurrentlyModifiedException(s.id);
    payment.markPersisted();
  }

  async list(criteria: ListPaymentsCriteria): Promise<CursorPage<Payment>> {
    // Decoded (and validated: a forged cursor is a 422, never SQL) before choosing the statement.
    const { userId, cursor } = criteria;
    const cursorId = isNil(cursor) || cursor === '' ? undefined : decodeIdCursor(cursor).id;
    const limit = keysetFetchLimit(criteria.limit); // + 1 look-ahead row → is there a next page?
    const rows =
      userId === undefined
        ? cursorId === undefined
          ? await this.statements.all.execute({ limit })
          : await this.statements.allAfter.execute({ cursorId, limit })
        : cursorId === undefined
          ? await this.statements.byUser.execute({ userId, limit })
          : await this.statements.byUserAfter.execute({ userId, cursorId, limit });
    return keysetPage(rows.map(fromPaymentRow), criteria.limit);
  }
}
