import { Injectable } from '@nestjs/common';
import { type ICommand, type IEvent, ofType, Saga } from '@nestjs/cqrs';
import { map, type Observable } from 'rxjs';
import { NotificationCreatedEvent } from '../../domain/events/notification-created.event.js';
import { PublishNotificationCreatedCommand } from '../commands/publish-notification-created/publish-notification-created.command.js';

/**
 * Event → command choreography. Kept as pure mapping on purpose: an error thrown INSIDE a saga's
 * operator pipeline completes the saga stream for good (nest-distributed §6.5), so all I/O lives
 * in the command handler. Sagas must be singletons.
 */
@Injectable()
export class NotificationsSagas {
  @Saga()
  notificationCreated = (events$: Observable<IEvent>): Observable<ICommand> =>
    events$.pipe(
      ofType(NotificationCreatedEvent),
      map((event) => new PublishNotificationCreatedCommand(event.notification)),
    );
}
