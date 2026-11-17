import type { CursorPage } from '@platform/common';
import type { MemberRecord, TenantMembership } from './memberships.repository.js';

/**
 * Member-directory and my-tenants reads on the system pool (BYPASSRLS; `system` methods, inside
 * `SystemContext.run` only). The row-local policies hide co-members' `users` rows and every tenant
 * but the session tenant from a runtime principal; the caller asserts the scope and the SQL
 * filters on it.
 */
export abstract class MembershipsSystemRepository {
  /** A member of `tenantId` (asserted by the caller) with the user profile; null when not one. */
  abstract findMember(tenantId: string, userId: string): Promise<MemberRecord | null>;

  /** Keyset page on user_id (newest user first) within `tenantId`; cursor = encodeIdCursor(userId). */
  abstract listMembers(
    tenantId: string,
    criteria: { limit: number; cursor?: string | undefined },
  ): Promise<CursorPage<MemberRecord>>;

  /**
   * Every membership of `userId` (the caller itself) with its tenant: latest `last_active_at`
   * first (NULLs last), then newest `created_at`.
   */
  abstract listForUser(userId: string): Promise<TenantMembership[]>;
}
