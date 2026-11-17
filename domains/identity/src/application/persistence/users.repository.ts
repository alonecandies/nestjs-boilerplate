import type { UserAggregate, UserSnapshot } from '../../domain/user.aggregate.js';

/** Public projection of a user: everything but the password hash. */
export type UserRecord = Omit<UserSnapshot, 'passwordHash'>;

export interface ListUsersCriteria {
  /** Only members of this tenant (join on identity.memberships). */
  tenantId: string;
  /** Already clamped to `[1, MAX_PAGE_LIMIT]`. */
  limit: number;
  /** Opaque keyset cursor from a previous page. */
  cursor?: string | undefined;
  /** Case-insensitive substring of email or display name (already trimmed, non-empty). */
  search?: string | undefined;
}

/**
 * Users persistence port on the runtime pool (implemented by `DrizzleUsersRepository`; every call
 * runs as the CLS principal). Under the row-local policies the principal reads and writes only
 * its own row: the credential lookups and the member directory are on `UsersSystemRepository`.
 * Reads return `UserRecord` (no hash). Writes are granular so concurrent updates of different
 * fields (roles vs. a password re-hash) never overwrite each other.
 */
export abstract class UsersRepository {
  abstract findById(id: string): Promise<UserRecord | null>;

  /** ONE query for all ids (no N+1). Unknown and hidden ids are omitted; order is unspecified. */
  abstract findByIds(ids: readonly string[]): Promise<UserRecord[]>;

  /** Fresh read of the staff flag (switch-in authorises on this, never on a token). Unknown id → false. */
  abstract isPlatformStaff(id: string): Promise<boolean>;

  /** @throws EmailAlreadyTakenException when the email unique constraint rejects the row. */
  abstract insert(user: UserAggregate): Promise<void>;

  /** @throws RowCountMismatchError unless exactly one row (the principal's own) was updated */
  abstract updatePasswordHash(id: string, passwordHash: string, updatedAt: Date): Promise<void>;
}
