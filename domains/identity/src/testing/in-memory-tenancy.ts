import { type CursorPage, normalizeTenantRoles } from '@platform/common';
import { decodeIdCursor, keysetPage } from '@platform/database';
import {
  type AuditEventRecord,
  AuditEventsRepository,
  InvalidRolesException,
  type InvitationRecord,
  InvitationsRepository,
  MembershipAlreadyExistsException,
  type MembershipRecord,
  MembershipsRepository,
  type NewAuditEvent,
  type NewInvitation,
  type NewMembership,
  type NewTenant,
  type TenantMembership,
  type TenantRecord,
  TenantSlugTakenException,
  TenantsRepository,
} from '../index.js';
import type { InMemoryIdentityStore } from './in-memory-identity.js';

/** Key of `InMemoryIdentityStore.memberships`. */
export const membershipKey = (tenantId: string, userId: string): string => `${tenantId}:${userId}`;

/** `ORDER BY last_active_at DESC NULLS LAST, created_at DESC`. */
function recentFirst(a: MembershipRecord, b: MembershipRecord): number {
  if (a.lastActiveAt === null || b.lastActiveAt === null) {
    if (a.lastActiveAt !== b.lastActiveAt) return a.lastActiveAt === null ? 1 : -1;
  } else if (a.lastActiveAt.getTime() !== b.lastActiveAt.getTime()) {
    return b.lastActiveAt.getTime() - a.lastActiveAt.getTime();
  }
  return b.createdAt.getTime() - a.createdAt.getTime();
}

export class InMemoryTenantsRepository extends TenantsRepository {
  constructor(private readonly store: InMemoryIdentityStore) {
    super();
  }

  async insert(tenant: NewTenant): Promise<void> {
    if (await this.existsBySlug(tenant.slug)) throw new TenantSlugTakenException();
    this.store.tenants.set(tenant.id, { ...tenant, createdAt: new Date() });
  }

  async findById(id: string): Promise<TenantRecord | null> {
    return this.store.tenants.get(id) ?? null;
  }

  async findByIds(ids: readonly string[]): Promise<TenantRecord[]> {
    return [...new Set(ids)].flatMap((id) => {
      const tenant = this.store.tenants.get(id);
      return tenant ? [tenant] : [];
    });
  }

  async existsBySlug(slug: string): Promise<boolean> {
    return [...this.store.tenants.values()].some((tenant) => tenant.slug === slug);
  }

  async rename(id: string, name: string): Promise<boolean> {
    const tenant = this.store.tenants.get(id);
    if (!tenant) return false;
    this.store.tenants.set(id, { ...tenant, name });
    return true;
  }
}

export class InMemoryMembershipsRepository extends MembershipsRepository {
  constructor(private readonly store: InMemoryIdentityStore) {
    super();
  }

  async insert(membership: NewMembership): Promise<void> {
    const roles = normalizeTenantRoles(membership.roles);
    if (roles.length === 0) {
      throw new InvalidRolesException([
        { path: 'roles', message: 'At least one role is required' },
      ]);
    }
    const key = membershipKey(membership.tenantId, membership.userId);
    if (this.store.memberships.has(key)) throw new MembershipAlreadyExistsException();
    this.store.memberships.set(key, { ...membership, roles, createdAt: new Date() });
  }

  async find(tenantId: string, userId: string): Promise<MembershipRecord | null> {
    return this.store.memberships.get(membershipKey(tenantId, userId)) ?? null;
  }

  async findMostRecentForUser(userId: string): Promise<MembershipRecord | null> {
    return this.ofUser(userId)[0] ?? null;
  }

  async listForUser(userId: string): Promise<TenantMembership[]> {
    return this.ofUser(userId).flatMap((membership) => {
      const tenant = this.store.tenants.get(membership.tenantId);
      return tenant ? [{ ...membership, tenant }] : [];
    });
  }

  async touch(tenantId: string, userId: string, at: Date): Promise<void> {
    const key = membershipKey(tenantId, userId);
    const membership = this.store.memberships.get(key);
    if (membership) this.store.memberships.set(key, { ...membership, lastActiveAt: at });
  }

  private ofUser(userId: string): MembershipRecord[] {
    return [...this.store.memberships.values()]
      .filter((m) => m.userId === userId)
      .sort(recentFirst);
  }
}

export class InMemoryInvitationsRepository extends InvitationsRepository {
  constructor(private readonly store: InMemoryIdentityStore) {
    super();
  }

  async insert(invitation: NewInvitation): Promise<void> {
    this.store.invitations.set(`${invitation.tenantId}:${invitation.id}`, {
      ...invitation,
      roles: [...invitation.roles],
      acceptedAt: null,
      createdAt: new Date(),
    });
  }

  async findByTokenHash(tokenHash: string): Promise<InvitationRecord | null> {
    return [...this.store.invitations.values()].find((i) => i.tokenHash === tokenHash) ?? null;
  }

  async listPending(tenantId: string, now: Date): Promise<InvitationRecord[]> {
    return [...this.store.invitations.values()]
      .filter((i) => i.tenantId === tenantId && i.acceptedAt === null && i.expiresAt > now)
      .sort((a, b) => b.id.localeCompare(a.id));
  }

  async markAccepted(tenantId: string, id: string, now: Date): Promise<boolean> {
    const key = `${tenantId}:${id}`;
    const invitation = this.store.invitations.get(key);
    if (!invitation || invitation.acceptedAt !== null || invitation.expiresAt <= now) return false;
    this.store.invitations.set(key, { ...invitation, acceptedAt: now });
    return true;
  }
}

export class InMemoryAuditEventsRepository extends AuditEventsRepository {
  constructor(private readonly store: InMemoryIdentityStore) {
    super();
  }

  async append(event: NewAuditEvent): Promise<void> {
    this.store.auditEvents.push({ ...event, data: { ...event.data } });
  }

  async listForTenant(
    tenantId: string,
    criteria: { limit: number; cursor?: string | undefined },
  ): Promise<CursorPage<AuditEventRecord>> {
    const after = criteria.cursor === undefined ? undefined : decodeIdCursor(criteria.cursor).id;
    const rows = this.store.auditEvents
      .filter((e) => e.tenantId === tenantId && (after === undefined || e.id < after))
      .sort((a, b) => b.id.localeCompare(a.id))
      .slice(0, criteria.limit + 1);
    return keysetPage(rows, criteria.limit);
  }
}
