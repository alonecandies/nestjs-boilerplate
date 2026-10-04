import type { CursorPage } from '@app/common';
import type { UserAggregate, UserSnapshot } from '../../domain/user.aggregate.js';
import type { UserRole } from '../../domain/user-role.js';

/** Public projection of a user: everything but the password hash. */
export type UserRecord = Omit<UserSnapshot, 'passwordHash'>;

export interface ListUsersCriteria {
  /** Already clamped to `[1, MAX_PAGE_LIMIT]`. */
  limit: number;
  /** Opaque keyset cursor from a previous page. */
  cursor?: string | undefined;
  /** Case-insensitive substring of email or display name (already trimmed, non-empty). */
  search?: string | undefined;
}

/**
 * Users persistence port (implemented by `DrizzleUsersRepository`). Reads return `UserRecord`
 * (no hash) except the credential lookup used by login. Writes are granular so concurrent
 * updates of different fields (roles vs. a password re-hash) never overwrite each other.
 */
export abstract class UsersRepository {
  abstract findById(id: string): Promise<UserRecord | null>;

  /** ONE query for all ids (no N+1). Unknown ids are omitted; order is unspecified. */
  abstract findByIds(ids: readonly string[]): Promise<UserRecord[]>;

  /** `email` must be normalised. Includes the password hash. */
  abstract findCredentialsByEmail(email: string): Promise<UserSnapshot | null>;

  abstract findAggregate(id: string): Promise<UserAggregate | null>;

  abstract existsByEmail(email: string): Promise<boolean>;

  /** Keyset page on the uuidv7 id, newest first. */
  abstract list(criteria: ListUsersCriteria): Promise<CursorPage<UserRecord>>;

  /** @throws EmailAlreadyTakenException when the email unique constraint rejects the row. */
  abstract insert(user: UserAggregate): Promise<void>;

  abstract updateRoles(id: string, roles: readonly UserRole[], updatedAt: Date): Promise<void>;

  abstract updatePasswordHash(id: string, passwordHash: string, updatedAt: Date): Promise<void>;
}
