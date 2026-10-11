import { Query } from '@nestjs/cqrs';
import type { User } from '@platform/contracts';

/** Batch lookup (DataLoader backend): unknown ids omitted, order follows `ids` (deduplicated). */
export class GetUsersByIdsQuery extends Query<User[]> {
  constructor(readonly ids: readonly string[]) {
    super();
  }
}
