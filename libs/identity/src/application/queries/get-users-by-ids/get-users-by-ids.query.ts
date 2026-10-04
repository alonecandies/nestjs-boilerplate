import type { User } from '@app/contracts';
import { Query } from '@nestjs/cqrs';

/** Batch lookup (DataLoader backend): unknown ids omitted, order follows `ids` (deduplicated). */
export class GetUsersByIdsQuery extends Query<User[]> {
  constructor(readonly ids: readonly string[]) {
    super();
  }
}
