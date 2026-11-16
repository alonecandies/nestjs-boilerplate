import type { CursorPage, TenantRole } from '@platform/common';
import type { TenantRecord } from './tenants.repository.js';

export interface MembershipRecord {
  readonly tenantId: string;
  readonly userId: string;
  readonly roles: readonly TenantRole[];
  readonly lastActiveAt: Date | null;
  readonly createdAt: Date;
}

export interface NewMembership {
  tenantId: string;
  userId: string;
  roles: readonly TenantRole[];
  lastActiveAt: Date | null;
}

/** A member of a tenant with the user profile (`memberships` joined to `users`). */
export interface MemberRecord {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly TenantRole[];
  readonly joinedAt: Date;
}

export interface TenantMembership extends MembershipRecord {
  readonly tenant: TenantRecord;
}

/** Memberships persistence port (`identity.memberships`, a reference table on Citus). */
export abstract class MembershipsRepository {
  /**
   * Roles are normalized (canonical order, deduplicated).
   * @throws InvalidRolesException when no valid role is left
   * @throws MembershipAlreadyExistsException on the (tenant_id, user_id) primary key
   */
  abstract insert(membership: NewMembership): Promise<void>;

  abstract find(tenantId: string, userId: string): Promise<MembershipRecord | null>;

  /** Latest `last_active_at` first (NULLs last), then newest `created_at`; `null` when the user has none. */
  abstract findMostRecentForUser(userId: string): Promise<MembershipRecord | null>;

  /** Every membership with its tenant, in the `findMostRecentForUser` order. */
  abstract listForUser(userId: string): Promise<TenantMembership[]>;

  /** Sets `last_active_at` (register, login and switch only; refresh never writes it). */
  abstract touch(tenantId: string, userId: string, at: Date): Promise<void>;

  /** Replaces the roles of one membership (already parsed); `false` when there is no such membership. */
  abstract updateRoles(
    tenantId: string,
    userId: string,
    roles: readonly TenantRole[],
  ): Promise<boolean>;

  /** `false` when there is no such membership. */
  abstract delete(tenantId: string, userId: string): Promise<boolean>;

  /**
   * pg_advisory_xact_lock(hashtext('identity:tenant-owners:' || tenantId)), then the number of owners.
   * Call it first inside the unit of work of every change that can remove an owner.
   */
  abstract countOwnersLocked(tenantId: string): Promise<number>;

  abstract findMember(tenantId: string, userId: string): Promise<MemberRecord | null>;

  /** Keyset page on user_id (newest user first) within the tenant; cursor = encodeIdCursor(userId). */
  abstract listMembers(
    tenantId: string,
    criteria: { limit: number; cursor?: string | undefined },
  ): Promise<CursorPage<MemberRecord>>;
}
