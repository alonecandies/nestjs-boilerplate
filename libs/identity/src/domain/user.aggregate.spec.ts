import { generateId } from '@app/common';
import { describe, expect, it } from 'vitest';
import { NOW } from '../../test/fixtures.js';
import { UserRegisteredEvent } from './events/user-registered.event.js';
import { UserRolesChangedEvent } from './events/user-roles-changed.event.js';
import {
  CannotRevokeOwnAdminRoleException,
  InvalidRolesException,
  InvalidUserException,
} from './identity.errors.js';
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
    it('normalises email + display name, grants the default role and applies UserRegisteredEvent', () => {
      const user = register();
      const snapshot = user.toSnapshot();

      expect(snapshot).toMatchObject({
        email: 'ada@example.com',
        displayName: 'Ada Lovelace',
        roles: ['user'],
        createdAt: NOW,
        updatedAt: NOW,
      });
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

  describe('changeRoles()', () => {
    const restoreWith = (roles: ('admin' | 'moderator' | 'user')[]) =>
      UserAggregate.restore({ ...register().toSnapshot(), roles });

    it('replaces the roles in canonical order, bumps updatedAt and applies UserRolesChangedEvent', () => {
      const user = restoreWith(['user']);
      const later = new Date(NOW.getTime() + 1_000);
      const actorId = generateId();

      expect(user.changeRoles(['user', 'admin', 'user'], actorId, later)).toBe(true);

      expect(user.roles).toEqual(['admin', 'user']);
      expect(user.toSnapshot().updatedAt).toEqual(later);
      const [event] = user.getUncommittedEvents();
      expect(event).toBeInstanceOf(UserRolesChangedEvent);
      expect(event).toMatchObject({
        userId: user.id,
        previousRoles: ['user'],
        roles: ['admin', 'user'],
        actorId,
      });
    });

    it('is a no-op (false, no event) when the set does not change', () => {
      const user = restoreWith(['moderator', 'user']);
      expect(user.changeRoles(['user', 'moderator'], generateId(), NOW)).toBe(false);
      expect(user.getUncommittedEvents()).toEqual([]);
    });

    it('rejects an empty list and unknown role names', () => {
      const user = restoreWith(['user']);
      expect(() => user.changeRoles([], generateId(), NOW)).toThrow(InvalidRolesException);
      expect(() => user.changeRoles(['root', 'user'], generateId(), NOW)).toThrow(
        expect.objectContaining({
          code: 'INVALID_ROLES',
          issues: [expect.objectContaining({ message: expect.stringContaining('"root"') })],
        }),
      );
    });

    it('forbids an admin from removing their own admin role', () => {
      const admin = restoreWith(['admin']);
      expect(() => admin.changeRoles(['user'], admin.id, NOW)).toThrow(
        CannotRevokeOwnAdminRoleException,
      );
      // …but they may keep admin while adding others, and another admin may demote them.
      expect(admin.changeRoles(['admin', 'moderator'], admin.id, NOW)).toBe(true);
      expect(admin.changeRoles(['user'], generateId(), NOW)).toBe(true);
    });
  });

  it('restore() canonicalises stored roles and applies no events', () => {
    const user = UserAggregate.restore({
      ...register().toSnapshot(),
      roles: ['user', 'admin', 'user'],
    });
    expect(user.roles).toEqual(['admin', 'user']);
    expect(user.hasRole('admin')).toBe(true);
    expect(user.getUncommittedEvents()).toEqual([]);
  });

  it('toSnapshot() returns a copy', () => {
    const user = register();
    const snapshot = user.toSnapshot();
    (snapshot.roles as string[]).push('admin');
    expect(user.roles).toEqual(['user']);
  });
});
