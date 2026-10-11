import type { IEvent } from '@nestjs/cqrs';
import type { UserRole } from '../user-role.js';

/** An admin changed a user's roles (takes effect on the user's next token refresh, ≤ access TTL). */
export class UserRolesChangedEvent implements IEvent {
  constructor(
    readonly eventId: string,
    readonly userId: string,
    readonly previousRoles: readonly UserRole[],
    readonly roles: readonly UserRole[],
    readonly actorId: string,
    readonly occurredAt: Date,
  ) {}
}
