import type { User } from '@domain/identity-contracts';
import { Command } from '@nestjs/cqrs';

/** Replaces a user's roles (admin operation). */
export class UpdateUserRolesCommand extends Command<User> {
  constructor(
    readonly userId: string,
    /** Validated by the aggregate (unknown names → 422). */
    readonly roles: readonly string[],
    /** The authenticated admin performing the change. */
    readonly actorId: string,
  ) {
    super();
  }
}
