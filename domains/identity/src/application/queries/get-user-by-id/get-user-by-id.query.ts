import type { User } from '@domain/identity-contracts';
import { Query } from '@nestjs/cqrs';

/** @throws EntityNotFoundException — also for a user outside `tenantId` when it is given. */
export class GetUserByIdQuery extends Query<User> {
  constructor(
    readonly id: string,
    readonly tenantId?: string | undefined,
  ) {
    super();
  }
}
