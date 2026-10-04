import type { PaymentList } from '@app/contracts';
import { Query } from '@nestjs/cqrs';

/**
 * One page of payments, newest first. `userId` omitted = every user (the edge enforces
 * `billing:read-all`); `cursor` = the previous page's `nextCursor`.
 */
export class ListPaymentsQuery extends Query<PaymentList> {
  constructor(
    readonly criteria: {
      userId?: string | undefined;
      limit?: number | undefined;
      cursor?: string | undefined;
    },
  ) {
    super();
  }
}
