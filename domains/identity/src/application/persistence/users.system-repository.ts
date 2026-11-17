import type { CursorPage } from '@platform/common';
import type { UserSnapshot } from '../../domain/user.aggregate.js';
import type { ListUsersCriteria, UserRecord } from './users.repository.js';

/**
 * Users reads on the system pool (BYPASSRLS; identity's named system methods). Under the row-local
 * policies a runtime principal reads only its own `users` row.
 */
export abstract class UsersSystemRepository {
  /** `pre-auth` (login): `email` must be normalised. Includes the password hash. */
  abstract findCredentialsByEmail(email: string): Promise<UserSnapshot | null>;

  /** `pre-auth` (register). */
  abstract existsByEmail(email: string): Promise<boolean>;

  /**
   * `system`: the user when they are a member of `tenantId`, else null. The caller asserts it acts
   * in `tenantId`; the SQL joins `memberships` on it.
   */
  abstract findByIdInTenant(id: string, tenantId: string): Promise<UserRecord | null>;

  /** `system`: the members of `criteria.tenantId` (asserted by the caller); keyset page, newest first. */
  abstract listInTenant(criteria: ListUsersCriteria): Promise<CursorPage<UserRecord>>;
}
