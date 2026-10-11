import { Query } from '@nestjs/cqrs';
import type { User } from '@platform/contracts';

/** @throws EntityNotFoundException */
export class GetUserByIdQuery extends Query<User> {
  constructor(readonly id: string) {
    super();
  }
}
