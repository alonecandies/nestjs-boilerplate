import { Query } from '@nestjs/cqrs';
import type { UserPage } from '@platform/contracts';

/** Keyset-paginated listing, newest first, with optional email/display-name search. */
export class ListUsersQuery extends Query<UserPage> {
  constructor(
    readonly limit?: number | undefined,
    readonly cursor?: string | undefined,
    readonly search?: string | undefined,
  ) {
    super();
  }
}
