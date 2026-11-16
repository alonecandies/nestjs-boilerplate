import type { MemberPage } from '@domain/identity-contracts';
import { Query } from '@nestjs/cqrs';

/** One keyset page of the members of the principal's active tenant (`limit` 0 = default page). */
export class ListMembersQuery extends Query<MemberPage> {
  constructor(
    readonly tenantId: string,
    readonly limit: number,
    readonly cursor?: string,
  ) {
    super();
  }
}
