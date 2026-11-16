import { generateId } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { NOW } from '../../test/fixtures.js';
import { UserRegisteredEvent } from './events/user-registered.event.js';
import { InvalidUserException } from './identity.errors.js';
import { UserAggregate } from './user.aggregate.js';

const register = (overrides: Partial<Parameters<typeof UserAggregate.register>[0]> = {}) =>
  UserAggregate.register({
    id: generateId(),
    email: '  Ada@Example.COM ',
    displayName: '  Ada Lovelace ',
    passwordHash: '$argon2id$hash',
    now: NOW,
    ...overrides,
  });

describe('UserAggregate', () => {
  describe('register()', () => {
    it('normalises email + display name, is not platform staff and applies UserRegisteredEvent', () => {
      const user = register();
      const snapshot = user.toSnapshot();

      expect(snapshot).toMatchObject({
        email: 'ada@example.com',
        displayName: 'Ada Lovelace',
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(user.toSnapshot()).toMatchObject({ isPlatformStaff: false });
      expect(user.toSnapshot()).not.toHaveProperty('roles');
      const events = user.getUncommittedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(UserRegisteredEvent);
      expect(events[0]).toMatchObject({
        userId: snapshot.id,
        email: 'ada@example.com',
        displayName: 'Ada Lovelace',
        occurredAt: NOW,
      });
      expect((events[0] as UserRegisteredEvent).eventId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('rejects a blank display name, an invalid email and an empty hash (all issues at once)', () => {
      const error = (() => {
        try {
          register({ email: 'nope', displayName: '   ', passwordHash: '' });
        } catch (caught) {
          return caught;
        }
        return undefined;
      })();
      expect(error).toBeInstanceOf(InvalidUserException);
      expect((error as InvalidUserException).issues.map((issue) => issue.path)).toEqual([
        'email',
        'displayName',
        'passwordHash',
      ]);
    });
  });

  it('restore() rehydrates the snapshot (staff flag included) and applies no events', () => {
    const user = UserAggregate.restore({ ...register().toSnapshot(), isPlatformStaff: true });
    expect(user.toSnapshot()).toMatchObject({ isPlatformStaff: true });
    expect(user.getUncommittedEvents()).toEqual([]);
  });

  it('toSnapshot() returns a copy', () => {
    const user = register();
    const snapshot = user.toSnapshot() as { email: string };
    snapshot.email = 'changed@example.com';
    expect(user.toSnapshot().email).toBe('ada@example.com');
  });
});
