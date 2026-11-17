import { generateId } from '@platform/common';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { NOW } from '../../test/fixtures.js';
import { UserRegisteredEvent } from './events/user-registered.event.js';
import { InvalidUserException } from './identity.errors.js';
import { type RegisterUserProps, UserAggregate } from './user.aggregate.js';

const props = (overrides: Partial<RegisterUserProps> = {}): RegisterUserProps => ({
  id: generateId(),
  email: '  Ada@Example.COM ',
  displayName: '  Ada Lovelace ',
  passwordHash: '$argon2id$hash',
  now: NOW,
  personalTenantId: generateId(),
  ...overrides,
});

const register = (overrides: Partial<RegisterUserProps> = {}) =>
  UserAggregate.register(props(overrides));

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

    it('UserRegisteredEvent carries the personal workspace id the caller chose', () => {
      const personalTenantId = generateId();
      const [event] = register({ personalTenantId }).getUncommittedEvents();
      expect(event).toMatchObject({ tenantId: personalTenantId });
    });

    it('requires the personal workspace id: no fallback tenant the event could name (compile time)', () => {
      expectTypeOf<RegisterUserProps['personalTenantId']>().toEqualTypeOf<string>();
      const { personalTenantId: _omitted, ...withoutWorkspace } = props();
      // @ts-expect-error -- registering without the workspace id must not compile
      expectTypeOf(UserAggregate.register).toBeCallableWith(withoutWorkspace);
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
