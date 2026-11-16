import type {
  LeaveTenantRequest,
  ListMembersRequest,
  Member,
  MemberPage,
  RemoveMemberRequest,
  UpdateMemberRolesRequest,
} from '@domain/identity-contracts';
import { Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { LeaveTenantCommand } from '../../../application/commands/leave-tenant/leave-tenant.command.js';
import { RemoveMemberCommand } from '../../../application/commands/remove-member/remove-member.command.js';
import { UpdateMemberRolesCommand } from '../../../application/commands/update-member-roles/update-member-roles.command.js';
import type { MembersPort } from '../../../application/ports/members.port.js';
import { ListMembersQuery } from '../../../application/queries/list-members/list-members.query.js';

/** Monolith binding of `MembersPort`: the CQRS buses of `IdentityCoreModule`. */
@Injectable()
export class MembersLocalAdapter implements MembersPort {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  listMembers(input: ListMembersRequest): Promise<MemberPage> {
    return this.queryBus.execute(new ListMembersQuery(input.tenantId, input.limit, input.cursor));
  }

  updateMemberRoles(input: UpdateMemberRolesRequest): Promise<Member> {
    return this.commandBus.execute(
      new UpdateMemberRolesCommand(input.tenantId, input.actorId, input.userId, input.roles),
    );
  }

  removeMember(input: RemoveMemberRequest): Promise<void> {
    return this.commandBus.execute(
      new RemoveMemberCommand(input.tenantId, input.actorId, input.userId),
    );
  }

  leaveTenant(input: LeaveTenantRequest): Promise<void> {
    return this.commandBus.execute(new LeaveTenantCommand(input.tenantId, input.userId));
  }
}
