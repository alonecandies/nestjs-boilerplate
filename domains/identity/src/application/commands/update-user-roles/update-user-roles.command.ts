import { Command } from '@nestjs/cqrs';
import type { User } from '@platform/contracts';

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
