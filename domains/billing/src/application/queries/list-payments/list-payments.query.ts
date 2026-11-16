import type { PaymentList } from '@domain/billing-contracts';
import { Query } from '@nestjs/cqrs';

/**
 * One page of payments, newest first. `userId` omitted = every payment of the tenant (`ListPaymentsHandler`
 * recomputes `billing:read-all` from the principal); `cursor` = the previous page's `nextCursor`.
 */
export class ListPaymentsQuery extends Query<PaymentList> {
  constructor(
    readonly criteria: {
      /** Always the caller's active tenant. */
      tenantId: string;
      userId?: string | undefined;
      limit?: number | undefined;
      cursor?: string | undefined;
    },
  ) {
    super();
  }
}
