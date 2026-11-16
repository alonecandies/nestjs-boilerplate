import type { ListUsersRequest, User, UserPage } from '@domain/identity-contracts';

/**
 * User queries for the presentation layer (and other domains' GraphQL
 * fields through the `users` DataLoader). Local adapter = QueryBus, remote adapter =
 * gRPC `identity.v1.UsersService`.
 */
export abstract class UsersPort {
  /** @throws EntityNotFoundException (404) */
  abstract getUser(id: string): Promise<User>;

  /** One round trip for all ids; unknown ids are omitted, order follows `ids` (deduplicated). */
  abstract getUsersByIds(ids: readonly string[]): Promise<User[]>;

  /** Keyset page (uuidv7 ids, newest first); `nextCursor` is absent on the last page. */
  abstract listUsers(query: ListUsersRequest): Promise<UserPage>;
}
