import {
  type AcceptInvitationRequest,
  type CreateInvitationRequest,
  type CreateTenantRequest,
  type Invitation,
  type LeaveTenantRequest,
  type ListMembersRequest,
  type ListMyTenantsRequest,
  type Member,
  type MemberPage,
  type MyTenant,
  type MyTenantList,
  type RemoveMemberRequest,
  type RenameTenantRequest,
  type Tenant,
  type TenantsServiceController,
  TenantsServiceControllerMethods,
  type UpdateMemberRolesRequest,
} from '@domain/identity-contracts';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Payload } from '@nestjs/microservices';
import { GrpcController, ZodRpcValidationPipe } from '@platform/transport';
import { AcceptInvitationCommand } from '../../application/commands/accept-invitation/accept-invitation.command.js';
import { CreateInvitationCommand } from '../../application/commands/create-invitation/create-invitation.command.js';
import { CreateTenantCommand } from '../../application/commands/create-tenant/create-tenant.command.js';
import { LeaveTenantCommand } from '../../application/commands/leave-tenant/leave-tenant.command.js';
import { RemoveMemberCommand } from '../../application/commands/remove-member/remove-member.command.js';
import { RenameTenantCommand } from '../../application/commands/rename-tenant/rename-tenant.command.js';
import { UpdateMemberRolesCommand } from '../../application/commands/update-member-roles/update-member-roles.command.js';
import { ListMembersQuery } from '../../application/queries/list-members/list-members.query.js';
import { ListMyTenantsQuery } from '../../application/queries/list-my-tenants/list-my-tenants.query.js';
import {
  acceptInvitationRequestSchema,
  createInvitationRequestSchema,
  createTenantRequestSchema,
  leaveTenantRequestSchema,
  listMembersRequestSchema,
  listMyTenantsRequestSchema,
  removeMemberRequestSchema,
  renameTenantRequestSchema,
  updateMemberRolesRequestSchema,
} from './tenancy-rpc.payloads.js';

/** `identity.v1.TenantsService` (identity-service). Authorization: the handlers cross-check the principal. */
@GrpcController()
@TenantsServiceControllerMethods()
export class TenantsGrpcController implements TenantsServiceController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  listMyTenants(
    @Payload(new ZodRpcValidationPipe(listMyTenantsRequestSchema)) r: ListMyTenantsRequest,
  ): Promise<MyTenantList> {
    return this.queryBus.execute(new ListMyTenantsQuery(r.userId));
  }

  createTenant(
    @Payload(new ZodRpcValidationPipe(createTenantRequestSchema)) r: CreateTenantRequest,
  ): Promise<MyTenant> {
    return this.commandBus.execute(new CreateTenantCommand(r.userId, r.name));
  }

  renameTenant(
    @Payload(new ZodRpcValidationPipe(renameTenantRequestSchema)) r: RenameTenantRequest,
  ): Promise<Tenant> {
    return this.commandBus.execute(new RenameTenantCommand(r.tenantId, r.actorId, r.name));
  }

  listMembers(
    @Payload(new ZodRpcValidationPipe(listMembersRequestSchema)) r: ListMembersRequest,
  ): Promise<MemberPage> {
    return this.queryBus.execute(new ListMembersQuery(r.tenantId, r.limit, r.cursor));
  }

  updateMemberRoles(
    @Payload(new ZodRpcValidationPipe(updateMemberRolesRequestSchema)) r: UpdateMemberRolesRequest,
  ): Promise<Member> {
    return this.commandBus.execute(
      new UpdateMemberRolesCommand(r.tenantId, r.actorId, r.userId, r.roles),
    );
  }

  /** Resolves `undefined`, which serialises as `google.protobuf.Empty`. */
  removeMember(
    @Payload(new ZodRpcValidationPipe(removeMemberRequestSchema)) r: RemoveMemberRequest,
  ): Promise<void> {
    return this.commandBus.execute(new RemoveMemberCommand(r.tenantId, r.actorId, r.userId));
  }

  leaveTenant(
    @Payload(new ZodRpcValidationPipe(leaveTenantRequestSchema)) r: LeaveTenantRequest,
  ): Promise<void> {
    return this.commandBus.execute(new LeaveTenantCommand(r.tenantId, r.userId));
  }

  createInvitation(
    @Payload(new ZodRpcValidationPipe(createInvitationRequestSchema)) r: CreateInvitationRequest,
  ): Promise<Invitation> {
    return this.commandBus.execute(
      new CreateInvitationCommand(r.tenantId, r.actorId, r.email, r.roles),
    );
  }

  acceptInvitation(
    @Payload(new ZodRpcValidationPipe(acceptInvitationRequestSchema)) r: AcceptInvitationRequest,
  ): Promise<MyTenant> {
    return this.commandBus.execute(new AcceptInvitationCommand(r.userId, r.token));
  }
}
