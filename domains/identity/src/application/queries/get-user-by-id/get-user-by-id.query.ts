import type { User } from '@domain/identity-contracts';
import { Query } from '@nestjs/cqrs';

/** @throws EntityNotFoundException */
export class GetUserByIdQuery extends Query<User> {
  constructor(readonly id: string) {
    super();
  }
}
