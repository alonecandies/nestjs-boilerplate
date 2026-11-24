import type {
  AcceptInvitationRequest,
  CreateInvitationRequest,
  CreateTenantRequest,
  Invitation,
  LeaveTenantRequest,
  ListMembersRequest,
  ListMyTenantsRequest,
  Member,
  MemberPage,
  MyTenant,
  MyTenantList,
  RemoveMemberRequest,
  RenameTenantRequest,
  Tenant,
  UpdateMemberRolesRequest,
} from '@domain/identity-contracts';
import { RbacRegistry } from '@platform/auth';
import {
  EntityNotFoundException,
  generateId,
  getPrincipal,
  PermissionDeniedException,
  requirePrincipal,
  satisfiesTenantRole,
  type TenantRole,
} from '@platform/common';
import {
  IDENTITY_RBAC,
  IdentityPermission,
  InvitationsPort,
  MembersPort,
  TenantsPort,
} from '../api/index.js';
import {
  assertCanAssignRoles,
  assertCanRemove,
  generateInvitationToken,
  INVITATION_TTL_MS,
  InvitationEmailMismatchException,
  InvitationInvalidException,
  LastOwnerException,
  MembershipAlreadyExistsException,
  memberForViewer,
  parseTenantRoles,
  TenantAccessDeniedException,
} from '../index.js';
import type { FakeIdentityState } from './fake-identity-ports.js';

/** Identity's vocabulary, as identity-service's registry holds it (users:read for the directory). */
const IDENTITY_REGISTRY = new RbacRegistry();
IDENTITY_REGISTRY.register(IDENTITY_RBAC);

export interface FakeInvitation {
  id: string;
  tenantId: string;
  email: string;
  roles: TenantRole[];
  token: string;
  expiresAt: Date;
  acceptedAt: Date | null;
}

/** Tenancy state of the fake identity-service, on top of `FakeIdentityState` (users, tenants, memberships). */
export class FakeTenancyState {
  readonly invitations: FakeInvitation[] = [];

  constructor(readonly identity: FakeIdentityState) {}

  lastTokenFor(email: string): string | undefined {
    return this.invitations.filter((i) => i.email === email).at(-1)?.token;
  }

  tenant(id: string): Tenant {
    const tenant = this.identity.tenants.get(id);
    if (!tenant) throw new EntityNotFoundException('Tenant', id);
    return {
      id,
      slug: `${tenant.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}-${id.slice(-8)}`,
      name: tenant.name,
      personal: tenant.personal,
    };
  }

  myTenant(tenantId: string, userId: string): MyTenant {
    const membership = this.identity.membership(tenantId, userId);
    if (!membership) throw new TenantAccessDeniedException();
    return { tenant: this.tenant(tenantId), roles: [...membership.roles] };
  }

  rolesOf(tenantId: string, userId: string): TenantRole[] {
    const membership = this.identity.membership(tenantId, userId);
    if (!membership) throw new TenantAccessDeniedException();
    return [...membership.roles];
  }

  /**
   * The acting user's roles, as `actorTenantRoles` computes them: the membership row, or the token
   * roles of a staff switch-in principal (no membership). The gateway's JwtAuthGuard put that
   * principal in CLS for this request.
   */
  actorRoles(tenantId: string, actorId: string): TenantRole[] {
    const principal = getPrincipal();
    if (
      principal?.staff === true &&
      principal.userId === actorId &&
      principal.tenantId === tenantId
    ) {
      return [...principal.roles];
    }
    return this.rolesOf(tenantId, actorId);
  }

  owners(tenantId: string): number {
    return this.identity.memberships.filter(
      (m) => m.tenantId === tenantId && m.roles.includes('owner'),
    ).length;
  }

  member(tenantId: string, userId: string): Member {
    const entry = this.identity.users.get(userId);
    const membership = this.identity.membership(tenantId, userId);
    if (!entry || !membership) throw new EntityNotFoundException('Member', userId);
    return {
      userId,
      email: entry.user.email,
      displayName: entry.user.displayName,
      roles: [...membership.roles],
    };
  }
}

export class FakeTenantsPort extends TenantsPort {
  constructor(private readonly state: FakeTenancyState) {
    super();
  }

  async listMyTenants({ userId }: ListMyTenantsRequest): Promise<MyTenantList> {
    return {
      items: this.state.identity
        .membershipsOf(userId)
        .map((m) => this.state.myTenant(m.tenantId, userId)),
    };
  }

  async createTenant({ userId, name }: CreateTenantRequest): Promise<MyTenant> {
    const id = generateId();
    this.state.identity.tenants.set(id, { id, name: name.trim(), personal: false });
    this.state.identity.addMembership(id, userId, ['owner']);
    return this.state.myTenant(id, userId);
  }

  async renameTenant({ tenantId, actorId, name }: RenameTenantRequest): Promise<Tenant> {
    if (!satisfiesTenantRole(this.state.actorRoles(tenantId, actorId), 'owner')) {
      // Same error as RenameTenantHandler.
      throw new PermissionDeniedException('Only an owner can rename the workspace', {
        details: { required: ['tenant:manage'] },
      });
    }
    const tenant = this.state.identity.tenants.get(tenantId);
    if (tenant) tenant.name = name.trim();
    return this.state.tenant(tenantId);
  }
}

export class FakeMembersPort extends MembersPort {
  constructor(private readonly state: FakeTenancyState) {
    super();
  }

  /**
   * As `ListMembersHandler` (`members-port.contract.spec.ts` runs the same cases on both): no
   * principal is a 401 `PRINCIPAL_MISSING`; a principal acting in another tenant, or of this tenant
   * without a membership, is a 403 `TENANT_ACCESS_DENIED`. Co-members' emails and roles only for a
   * caller whose membership (a staff switch-in: its token) grants `users:read`; the caller's own
   * row stays complete.
   */
  async listMembers({ tenantId }: ListMembersRequest): Promise<MemberPage> {
    const viewer = requirePrincipal();
    if (viewer.tenantId !== tenantId) throw new TenantAccessDeniedException();
    const directory = IDENTITY_REGISTRY.resolve(
      this.state.actorRoles(tenantId, viewer.userId),
    ).includes(IdentityPermission.UsersRead);
    const ids = this.state.identity.memberships
      .filter((m) => m.tenantId === tenantId)
      .map((m) => m.userId);
    return {
      items: ids
        .sort()
        .reverse()
        .map((userId) =>
          memberForViewer(this.state.member(tenantId, userId), viewer.userId, directory),
        ),
    };
  }

  async updateMemberRoles({
    tenantId,
    actorId,
    userId,
    roles,
  }: UpdateMemberRolesRequest): Promise<Member> {
    const next = parseTenantRoles(roles);
    const current = this.state.rolesOf(tenantId, userId);
    assertCanAssignRoles(this.state.actorRoles(tenantId, actorId), current, next);
    if (current.includes('owner') && !next.includes('owner') && this.state.owners(tenantId) <= 1) {
      throw new LastOwnerException();
    }
    this.state.identity.setMembershipRoles(tenantId, userId, next);
    return this.state.member(tenantId, userId);
  }

  async removeMember({ tenantId, actorId, userId }: RemoveMemberRequest): Promise<void> {
    const target = this.state.rolesOf(tenantId, userId);
    assertCanRemove(this.state.actorRoles(tenantId, actorId), target);
    if (target.includes('owner') && this.state.owners(tenantId) <= 1)
      throw new LastOwnerException();
    this.state.identity.removeMembership(tenantId, userId);
  }

  async leaveTenant({ tenantId, userId }: LeaveTenantRequest): Promise<void> {
    if (
      this.state.rolesOf(tenantId, userId).includes('owner') &&
      this.state.owners(tenantId) <= 1
    ) {
      throw new LastOwnerException();
    }
    this.state.identity.removeMembership(tenantId, userId);
  }
}

export class FakeInvitationsPort extends InvitationsPort {
  constructor(private readonly state: FakeTenancyState) {
    super();
  }

  async createInvitation({
    tenantId,
    actorId,
    email,
    roles,
  }: CreateInvitationRequest): Promise<Invitation> {
    const invited = parseTenantRoles(roles);
    assertCanAssignRoles(this.state.actorRoles(tenantId, actorId), null, invited);
    const invitation: FakeInvitation = {
      id: generateId(),
      tenantId,
      email: email.trim().toLowerCase(),
      roles: invited,
      token: generateInvitationToken().token,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      acceptedAt: null,
    };
    this.state.invitations.push(invitation);
    const { token: _token, acceptedAt: _accepted, ...view } = invitation;
    return { ...view, roles: [...invited] };
  }

  async acceptInvitation({ userId, token }: AcceptInvitationRequest): Promise<MyTenant> {
    const invitation = this.state.invitations.find((i) => i.token === token);
    if (!invitation || invitation.acceptedAt !== null || invitation.expiresAt <= new Date()) {
      throw new InvitationInvalidException();
    }
    if (this.state.identity.users.get(userId)?.user.email !== invitation.email) {
      throw new InvitationEmailMismatchException();
    }
    if (this.state.identity.membership(invitation.tenantId, userId))
      throw new MembershipAlreadyExistsException();
    invitation.acceptedAt = new Date();
    this.state.identity.addMembership(invitation.tenantId, userId, invitation.roles);
    return this.state.myTenant(invitation.tenantId, userId);
  }
}
