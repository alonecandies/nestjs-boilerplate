import { EntityNotFoundException, generateId } from '@app/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordingPublisher } from '../../../../test/cqrs-fakes.js';
import { makeUserSnapshot, passThroughTransaction } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import { UserRolesChangedEvent } from '../../../domain/events/user-roles-changed.event.js';
import {
  CannotRemoveLastAdminException,
  CannotRevokeOwnAdminRoleException,
} from '../../../domain/identity.errors.js';
import { UserAggregate } from '../../../domain/user.aggregate.js';
import type { UsersRepository } from '../../persistence/users.repository.js';
import { UpdateUserRolesCommand } from './update-user-roles.command.js';
import { UpdateUserRolesHandler } from './update-user-roles.handler.js';

describe('UpdateUserRolesHandler', () => {
  const stored = makeUserSnapshot({ roles: ['user'] });
  let users: ReturnType<typeof mockOf<UsersRepository>>;
  let transaction: ReturnType<typeof passThroughTransaction>;
  let events: ReturnType<typeof recordingPublisher>;
  let handler: UpdateUserRolesHandler;
  /** What ran inside the (pass-through) transaction, and when the events were published. */
  const order: string[] = [];

  beforeEach(() => {
    order.length = 0;
    transaction = passThroughTransaction();
    const run = transaction.run;
    transaction.run = async (work) => {
      order.push('begin');
      const result = await run(work);
      order.push('commit');
      return result;
    };
    users = mockOf<UsersRepository>({
      findAggregate: async () => {
        order.push('find');
        return UserAggregate.restore(stored);
      },
      countAdmins: async () => {
        order.push('count-admins');
        return 2;
      },
      updateRoles: async () => {
        order.push('update');
      },
    });
    events = recordingPublisher();
    handler = new UpdateUserRolesHandler(users, transaction, events.publisher);
  });

  it('persists the new roles, publishes UserRolesChangedEvent and returns the contract user', async () => {
    const actorId = generateId();
    const result = await handler.execute(
      new UpdateUserRolesCommand(stored.id, ['moderator', 'user'], actorId),
    );

    expect(users.updateRoles).toHaveBeenCalledWith(
      stored.id,
      ['moderator', 'user'],
      expect.any(Date),
    );
    expect(result).toMatchObject({ id: stored.id, roles: ['moderator', 'user'] });
    expect(result).not.toHaveProperty('passwordHash');
    expect(events.published).toEqual([expect.any(UserRolesChangedEvent)]);
    expect(events.published[0]).toMatchObject({ actorId, previousRoles: ['user'] });
    // Locked read + write in ONE transaction; no admin was removed → no admin count.
    expect(transaction.runs).toBe(1);
    expect(order).toEqual(['begin', 'find', 'update', 'commit']);
  });

  it('publishes only after the transaction committed', async () => {
    users.updateRoles.mockImplementation(async () => {
      order.push('update');
      expect(events.published).toEqual([]);
    });
    await handler.execute(new UpdateUserRolesCommand(stored.id, ['moderator'], generateId()));
    expect(order.at(-1)).toBe('commit');
    expect(events.published).toHaveLength(1);
  });

  it('demoting an admin counts the admins inside the transaction, before the write', async () => {
    const admin = makeUserSnapshot({ roles: ['admin', 'user'] });
    users.findAggregate.mockResolvedValue(UserAggregate.restore(admin));
    const result = await handler.execute(
      new UpdateUserRolesCommand(admin.id, ['user'], generateId()),
    );
    expect(result.roles).toEqual(['user']);
    expect(order).toEqual(['begin', 'count-admins', 'update', 'commit']);
  });

  it('refuses to demote the last admin (422 CANNOT_REMOVE_LAST_ADMIN): no write, no event', async () => {
    const admin = makeUserSnapshot({ roles: ['admin'] });
    users.findAggregate.mockResolvedValue(UserAggregate.restore(admin));
    users.countAdmins.mockResolvedValue(1);
    await expect(
      handler.execute(new UpdateUserRolesCommand(admin.id, ['user'], generateId())),
    ).rejects.toBeInstanceOf(CannotRemoveLastAdminException);
    expect(users.updateRoles).not.toHaveBeenCalled();
    expect(events.published).toEqual([]);
  });

  it('granting admin or keeping it never counts admins', async () => {
    await handler.execute(new UpdateUserRolesCommand(stored.id, ['admin'], generateId()));
    const admin = makeUserSnapshot({ roles: ['admin'] });
    users.findAggregate.mockResolvedValue(UserAggregate.restore(admin));
    await handler.execute(new UpdateUserRolesCommand(admin.id, ['admin', 'moderator'], 'other'));
    expect(users.countAdmins).not.toHaveBeenCalled();
    expect(users.updateRoles).toHaveBeenCalledTimes(2);
  });

  it('an unchanged role set writes nothing and publishes nothing', async () => {
    const result = await handler.execute(new UpdateUserRolesCommand(stored.id, ['user'], 'admin'));
    expect(result.roles).toEqual(['user']);
    expect(users.updateRoles).not.toHaveBeenCalled();
    expect(events.published).toEqual([]);
  });

  it('unknown user → EntityNotFoundException (404)', async () => {
    users.findAggregate.mockResolvedValue(null);
    await expect(
      handler.execute(new UpdateUserRolesCommand(generateId(), ['user'], 'a')),
    ).rejects.toBeInstanceOf(EntityNotFoundException);
  });

  it('enforces the aggregate invariants (own admin role)', async () => {
    const admin = makeUserSnapshot({ roles: ['admin'] });
    users.findAggregate.mockResolvedValue(UserAggregate.restore(admin));
    await expect(
      handler.execute(new UpdateUserRolesCommand(admin.id, ['user'], admin.id)),
    ).rejects.toBeInstanceOf(CannotRevokeOwnAdminRoleException);
    expect(users.updateRoles).not.toHaveBeenCalled();
  });
});
