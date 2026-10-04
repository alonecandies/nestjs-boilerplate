import type { PaymentList } from '@app/contracts';
import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { clamp, isInteger } from 'lodash-es';
import { BILLING_LIMITS } from '../../../billing.constants.js';
import { toPaymentListContract } from '../../mappers/payment.mapper.js';
import { PaymentsRepository } from '../../repositories/payments.repository.js';
import { ListPaymentsQuery } from './list-payments.query.js';

/** Bounded, index-backed listing: `WHERE user_id = $1 ORDER BY id DESC LIMIT n` (one query). */
@QueryHandler(ListPaymentsQuery)
export class ListPaymentsHandler implements IQueryHandler<ListPaymentsQuery> {
  constructor(private readonly payments: PaymentsRepository) {}

  async execute({ criteria }: ListPaymentsQuery): Promise<PaymentList> {
    // 0 / absent = default (proto3 ints decode as 0); anything else is capped at MAX.
    const requested = criteria.limit ?? 0;
    const limit =
      isInteger(requested) && requested > 0
        ? clamp(requested, 1, BILLING_LIMITS.MAX_PAGE_SIZE)
        : BILLING_LIMITS.DEFAULT_PAGE_SIZE;
    const payments = await this.payments.list({ userId: criteria.userId, limit });
    return toPaymentListContract(payments);
  }
}
