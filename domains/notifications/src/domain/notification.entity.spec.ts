import { describe, expect, it } from 'vitest';
import { makeNotificationProps } from '../../test/support/fixtures.js';
import { NotificationCreatedEvent } from './events/notification-created.event.js';
import { NotificationEntity } from './notification.entity.js';
import { InvalidNotificationException } from './notification.errors.js';
import { NOTIFICATION_TITLE_MAX_LENGTH } from './notification.types.js';

const newProps = () => {
  const { read: _read, ...props } = makeNotificationProps();
  return props;
};

describe('NotificationEntity', () => {
  it('creates an unread notification and raises NotificationCreatedEvent with its state', () => {
    const props = newProps();
    const entity = NotificationEntity.create(props);

    expect(entity.id).toBe(props.id);
    expect(entity.userId).toBe(props.userId);
    expect(entity.isRead).toBe(false);
    const events = entity.getUncommittedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(NotificationCreatedEvent);
    expect((events[0] as NotificationCreatedEvent).notification).toEqual({ ...props, read: false });
  });

  it('copies input data so later mutations of the input do not leak in', () => {
    const props = newProps();
    const entity = NotificationEntity.create(props);
    props.data.injected = 'x';
    expect(entity.toSnapshot().data).toEqual({ link: '/inbox' });
  });

  it('rejects invariant violations with INVALID_NOTIFICATION and every issue', () => {
    const invalid = {
      ...newProps(),
      title: '   ',
      body: 'x'.repeat(2_001),
      createdAt: new Date('nope'),
    };
    const error = (() => {
      try {
        NotificationEntity.create(invalid);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(InvalidNotificationException);
    const exception = error as InvalidNotificationException;
    expect(exception.code).toBe('INVALID_NOTIFICATION');
    expect(exception.issues.map((issue) => issue.path)).toEqual(['title', 'body', 'createdAt']);
  });

  it('rejects titles over the limit and unknown types', () => {
    expect(() =>
      NotificationEntity.create({
        ...newProps(),
        title: 't'.repeat(NOTIFICATION_TITLE_MAX_LENGTH + 1),
      }),
    ).toThrow(InvalidNotificationException);
    expect(() =>
      NotificationEntity.create({ ...newProps(), type: 'spam' as unknown as 'system' }),
    ).toThrow(InvalidNotificationException);
  });

  it('marks read once (idempotent) and never raises events on restore', () => {
    const entity = NotificationEntity.restore(makeNotificationProps());
    expect(entity.getUncommittedEvents()).toHaveLength(0);
    expect(entity.markRead()).toBe(true);
    expect(entity.isRead).toBe(true);
    expect(entity.markRead()).toBe(false);
  });

  it('hands out defensive snapshots', () => {
    const entity = NotificationEntity.restore(makeNotificationProps());
    const snapshot = entity.toSnapshot();
    snapshot.read = true;
    snapshot.data.x = 'y';
    expect(entity.isRead).toBe(false);
    expect(entity.toSnapshot().data).toEqual({ link: '/inbox' });
  });
});
