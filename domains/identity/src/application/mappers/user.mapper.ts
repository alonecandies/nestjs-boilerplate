import type { User } from '@domain/identity-contracts';
import type { AccessTokenSubject } from '@platform/auth';
import type { TenantRole } from '@platform/common';
import type { UserSnapshot } from '../../domain/user.aggregate.js';
import type { UserRecord } from '../persistence/users.repository.js';

/**
 * Persistence/domain → wire contract. Field-by-field on purpose: a snapshot (which carries the
 * password hash) can be passed where a `UserRecord` is expected, and must never leak it.
 */
export function toUserContract(user: UserRecord): User {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    roles: [...user.roles],
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/** Drops the password hash. */
export function toUserRecord(user: UserSnapshot): UserRecord {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    roles: user.roles,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/** What goes into the access token: the user, the session's tenant and the roles held there. */
export function toAccessTokenSubject(
  user: UserRecord,
  tenantId: string,
  roles: readonly TenantRole[],
): AccessTokenSubject {
  return { id: user.id, email: user.email, tenantId, roles: [...roles] };
}
