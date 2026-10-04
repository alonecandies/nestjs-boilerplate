import type { PaymentList } from '@app/contracts';
import { Query } from '@nestjs/cqrs';

/** Newest payments first. `userId` omitted = every user (the edge enforces `billing:read-all`). */
export class ListPaymentsQuery extends Query<PaymentList> {
  constructor(
    readonly criteria: {
      userId?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    super();
  }
}
