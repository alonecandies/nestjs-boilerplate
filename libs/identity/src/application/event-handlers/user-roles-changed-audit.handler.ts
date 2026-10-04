import { Logger } from '@nestjs/common';
import { EventsHandler, type IEventHandler } from '@nestjs/cqrs';
import { UserRolesChangedEvent } from '../../domain/events/user-roles-changed.event.js';

/** Security audit trail of privilege changes (structured log line; ship it to your SIEM). */
@EventsHandler(UserRolesChangedEvent)
export class UserRolesChangedAuditHandler implements IEventHandler<UserRolesChangedEvent> {
  private readonly logger = new Logger('IdentityAudit');

  handle(event: UserRolesChangedEvent): void {
    this.logger.log(
      {
        audit: 'user.roles_changed',
        eventId: event.eventId,
        userId: event.userId,
        actorId: event.actorId,
        previousRoles: event.previousRoles,
        roles: event.roles,
      },
      'User roles changed',
    );
  }
}
