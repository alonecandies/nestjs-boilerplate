import type { MemberPage } from '@domain/identity-contracts';
import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { requirePrincipal } from '@platform/common';
import { toMemberContract } from '../../mappers/member.mapper.js';
import { MembershipsRepository } from '../../persistence/memberships.repository.js';
import { actorTenantRoles, requireTenantActor } from '../../services/tenant-actor.js';
import { ListMembersQuery } from './list-members.query.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

@QueryHandler(ListMembersQuery)
export class ListMembersHandler implements IQueryHandler<ListMembersQuery> {
  constructor(private readonly memberships: MembershipsRepository) {}

  async execute({ tenantId, limit, cursor }: ListMembersQuery): Promise<MemberPage> {
    const principal = requireTenantActor(tenantId, requirePrincipal().userId);
    // Any current member (or staff) may list; a member removed after their token was issued gets 403.
    await actorTenantRoles(principal, this.memberships);
    const size = limit <= 0 ? DEFAULT_PAGE_SIZE : Math.min(limit, MAX_PAGE_SIZE);
    const page = await this.memberships.listMembers(tenantId, { limit: size, cursor });
    return {
      items: page.items.map(toMemberContract),
      ...(page.nextCursor === null ? {} : { nextCursor: page.nextCursor }),
    };
  }
}
