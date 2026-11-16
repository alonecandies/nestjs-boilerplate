import type { Invitation, Member, MyTenant, Tenant } from '@domain/identity-contracts';
import type { AuthUser } from '@platform/auth';
import { normalizeTenantRoles } from '@platform/common';
import type { ActiveTenantModel } from './models/active-tenant.model.js';
import type { InvitationModel } from './models/invitation.model.js';
import type { MemberModel } from './models/member.model.js';
import type { MyTenantModel } from './models/my-tenant.model.js';
import type { TenantModel } from './models/tenant.model.js';

export const toTenantModel = (t: Tenant): TenantModel => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  personal: t.personal,
});

export function toMyTenantModel(mine: MyTenant): MyTenantModel {
  if (mine.tenant === undefined) throw new Error('MyTenant without its tenant');
  return {
    tenant: toTenantModel(mine.tenant),
    roles: normalizeTenantRoles(mine.roles),
    lastActiveAt: mine.lastActiveAt ?? null,
  };
}

export function toActiveTenantModel(
  user: Pick<AuthUser, 'tenantId' | 'roles' | 'staff'>,
  mine: readonly MyTenant[],
): ActiveTenantModel {
  const membership = user.staff ? undefined : mine.find((m) => m.tenant?.id === user.tenantId);
  return {
    tenantId: user.tenantId,
    tenant: membership?.tenant === undefined ? null : toTenantModel(membership.tenant),
    // The membership row is authoritative (a demoted user's token keeps its roles until it expires);
    // a staff switch-in has no membership and acts with the token's roles.
    roles: normalizeTenantRoles(membership?.roles ?? user.roles),
    staff: user.staff,
  };
}

export const toMemberModel = (m: Member): MemberModel => ({
  userId: m.userId,
  email: m.email,
  displayName: m.displayName,
  roles: normalizeTenantRoles(m.roles),
  joinedAt: m.joinedAt ?? new Date(0),
});

export const toInvitationModel = (i: Invitation): InvitationModel => ({
  id: i.id,
  tenantId: i.tenantId,
  email: i.email,
  roles: normalizeTenantRoles(i.roles),
  expiresAt: i.expiresAt ?? new Date(0),
});
