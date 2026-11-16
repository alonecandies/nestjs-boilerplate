import type { UserPage } from '@domain/identity-contracts';
import { Query } from '@nestjs/cqrs';

/** Keyset-paginated listing of one tenant's members, newest first, with optional search. */
export class ListUsersQuery extends Query<UserPage> {
  constructor(
    readonly tenantId: string,
    readonly limit?: number | undefined,
    readonly cursor?: string | undefined,
    readonly search?: string | undefined,
  ) {
    super();
  }
}
