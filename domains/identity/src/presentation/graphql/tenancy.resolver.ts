import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { type AuthUser, CurrentUser, RequirePermissions } from '@platform/auth';
import { GraphQLUUID } from '@platform/graphql';
import { InvitationsPort } from '../../application/ports/invitations.port.js';
import { MembersPort } from '../../application/ports/members.port.js';
import { TenantsPort } from '../../application/ports/tenants.port.js';
import { IdentityPermission } from '../../identity.permissions.js';
import { MembersArgs } from './args/members.args.js';
import { AcceptInvitationInput } from './inputs/accept-invitation.input.js';
import { InviteMemberInput } from './inputs/invite-member.input.js';
import { TenantNameInput } from './inputs/tenant-name.input.js';
import { UpdateMemberRolesInput } from './inputs/update-member-roles.input.js';
import { InvitationModel } from './models/invitation.model.js';
import { MemberModel } from './models/member.model.js';
import { MemberConnectionModel } from './models/member-connection.model.js';
import { MyTenantModel } from './models/my-tenant.model.js';
import { TenantModel } from './models/tenant.model.js';
import {
  toInvitationModel,
  toMemberModel,
  toMyTenantModel,
  toTenantModel,
} from './tenancy.mapper.js';

/**
 * Same ports and rules as the tenancy controllers (`/v1/tenants`, `/v1/tenant/...`). Guards are the
 * global ones (JwtAuthGuard → RolesGuard → PermissionsGuard), which are GraphQL-context aware.
 */
@Resolver()
export class TenancyResolver {
  constructor(
    private readonly tenants: TenantsPort,
    private readonly members: MembersPort,
    private readonly invitations: InvitationsPort,
  ) {}

  @Query(() => [MyTenantModel], { description: 'Your tenants, most recently active first' })
  async myTenants(@CurrentUser('id') userId: string): Promise<MyTenantModel[]> {
    return (await this.tenants.listMyTenants({ userId })).items.map(toMyTenantModel);
  }

  @Query(() => MemberConnectionModel, {
    description: 'Members of the active tenant',
    complexity: 10,
  })
  async tenantMembers(
    @Args() args: MembersArgs,
    @CurrentUser() user: AuthUser,
  ): Promise<MemberConnectionModel> {
    const page = await this.members.listMembers({
      tenantId: user.tenantId,
      limit: args.limit ?? 0,
      cursor: args.cursor ?? undefined,
    });
    return { items: page.items.map(toMemberModel), nextCursor: page.nextCursor ?? null };
  }

  @Mutation(() => MyTenantModel, { description: 'Create a tenant with you as its owner' })
  async createTenant(
    @Args('input') input: TenantNameInput,
    @CurrentUser('id') userId: string,
  ): Promise<MyTenantModel> {
    return toMyTenantModel(await this.tenants.createTenant({ userId, name: input.name }));
  }

  @Mutation(() => TenantModel, { description: 'Rename the active tenant (tenant:manage)' })
  @RequirePermissions(IdentityPermission.TenantManage)
  async renameTenant(
    @Args('input') input: TenantNameInput,
    @CurrentUser() user: AuthUser,
  ): Promise<TenantModel> {
    return toTenantModel(
      await this.tenants.renameTenant({
        tenantId: user.tenantId,
        actorId: user.id,
        name: input.name,
      }),
    );
  }

  @Mutation(() => InvitationModel, {
    description: 'Invite an email to the active tenant (members:manage)',
  })
  @RequirePermissions(IdentityPermission.MembersManage)
  async inviteMember(
    @Args('input') input: InviteMemberInput,
    @CurrentUser() user: AuthUser,
  ): Promise<InvitationModel> {
    return toInvitationModel(
      await this.invitations.createInvitation({
        tenantId: user.tenantId,
        actorId: user.id,
        email: input.email,
        roles: input.roles,
      }),
    );
  }

  @Mutation(() => MyTenantModel, {
    description: 'Join a tenant with the code from an invitation mail',
  })
  async acceptInvitation(
    @Args('input') input: AcceptInvitationInput,
    @CurrentUser('id') userId: string,
  ): Promise<MyTenantModel> {
    return toMyTenantModel(await this.invitations.acceptInvitation({ userId, token: input.token }));
  }

  @Mutation(() => MemberModel, { description: "Replace a member's roles (members:manage)" })
  @RequirePermissions(IdentityPermission.MembersManage)
  async updateMemberRoles(
    @Args('input') input: UpdateMemberRolesInput,
    @CurrentUser() user: AuthUser,
  ): Promise<MemberModel> {
    return toMemberModel(
      await this.members.updateMemberRoles({
        tenantId: user.tenantId,
        actorId: user.id,
        userId: input.userId,
        roles: input.roles,
      }),
    );
  }

  @Mutation(() => Boolean, { description: 'Remove a member (members:manage)' })
  @RequirePermissions(IdentityPermission.MembersManage)
  async removeMember(
    @Args('userId', { type: () => GraphQLUUID }) userId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<boolean> {
    await this.members.removeMember({ tenantId: user.tenantId, actorId: user.id, userId });
    return true;
  }

  @Mutation(() => Boolean, { description: 'Leave the active tenant (the last owner cannot)' })
  async leaveTenant(@CurrentUser() user: AuthUser): Promise<boolean> {
    await this.members.leaveTenant({ tenantId: user.tenantId, userId: user.id });
    return true;
  }
}
