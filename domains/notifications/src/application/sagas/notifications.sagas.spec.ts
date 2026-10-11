import type { IEvent } from '@nestjs/cqrs';
import { lastValueFrom, of, toArray } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { makeNotificationProps } from '../../../test/support/fixtures.js';
import { NotificationCreatedEvent } from '../../domain/events/notification-created.event.js';
import { PublishNotificationCreatedCommand } from '../commands/publish-notification-created/publish-notification-created.command.js';
import { NotificationsSagas } from './notifications.sagas.js';

class UnrelatedEvent implements IEvent {}

/** `@nestjs/cqrs`' saga metadata key (not exported from the package root). */
const SAGA_METADATA = '__saga__';

describe('NotificationsSagas', () => {
  it('is registered as a @Saga', () => {
    expect(Reflect.getMetadata(SAGA_METADATA, NotificationsSagas)).toEqual(['notificationCreated']);
  });

  it('maps every NotificationCreatedEvent to PublishNotificationCreatedCommand, ignoring others', async () => {
    const notification = makeNotificationProps();
    const commands = await lastValueFrom(
      new NotificationsSagas()
        .notificationCreated(of(new UnrelatedEvent(), new NotificationCreatedEvent(notification)))
        .pipe(toArray()),
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(PublishNotificationCreatedCommand);
    expect((commands[0] as PublishNotificationCreatedCommand).notification).toBe(notification);
  });
});
