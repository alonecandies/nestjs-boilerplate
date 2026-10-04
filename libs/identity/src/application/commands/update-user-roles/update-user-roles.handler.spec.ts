import { EntityNotFoundException, generateId } from '@app/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordingPublisher } from '../../../../test/cqrs-fakes.js';
import { makeUserSnapshot } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import { UserRolesChangedEvent } from '../../../domain/events/user-roles-changed.event.js';
import { CannotRevokeOwnAdminRoleException } from '../../../domain/identity.errors.js';
import { UserAggregate } from '../../../domain/user.aggregate.js';
import type { UsersRepository } from '../../persistence/users.repository.js';
import { UpdateUserRolesCommand } from './update-user-roles.command.js';
import { UpdateUserRolesHandler } from './update-user-roles.handler.js';

describe('UpdateUserRolesHandler', () => {
  const stored = makeUserSnapshot({ roles: ['user'] });
  let users: ReturnType<typeof mockOf<UsersRepository>>;
  let events: ReturnType<typeof recordingPublisher>;
  let handler: UpdateUserRolesHandler;

  beforeEach(() => {
    users = mockOf<UsersRepository>({
      findAggregate: async () => UserAggregate.restore(stored),
      updateRoles: async () => undefined,
    });
    events = recordingPublisher();
    handler = new UpdateUserRolesHandler(users, events.publisher);
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
