import type { TenantRole } from '@platform/common';
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

/**
 * Memberships persistence port on the runtime pool (`identity.memberships`, a reference table on
 * Citus). The principal reads its own memberships and those of its session tenant; writes need
 * elevation, except leaving (deleting its own row). The member directory (with user profiles) and
 * every tenant of a user are on `MembershipsSystemRepository`.
 */
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

  /**
   * Every membership whose tenant the principal can read (its session tenant: the tenants policy is
   * row-local), with that tenant, in the `findMostRecentForUser` order. Inside the unit of work
   * that just created a membership it sees the uncommitted row; all of a user's tenants:
   * `MembershipsSystemRepository.listForUser`.
   */
  abstract listForUser(userId: string): Promise<TenantMembership[]>;

  /**
   * Sets `last_active_at` (register, login and switch only; refresh never writes it). Needs an
   * elevated unit of work (the `membership-activity` justified elevation).
   * @throws RowCountMismatchError unless exactly one row was updated
   */
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
}
