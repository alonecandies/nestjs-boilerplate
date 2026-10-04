import type { CommandBus, QueryBus } from '@nestjs/cqrs';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeAuthTokens, makeUser } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import { LoginCommand } from '../../../application/commands/login/login.command.js';
import { LogoutCommand } from '../../../application/commands/logout/logout.command.js';
import { RefreshSessionCommand } from '../../../application/commands/refresh-session/refresh-session.command.js';
import { RegisterUserCommand } from '../../../application/commands/register-user/register-user.command.js';
import { UpdateUserRolesCommand } from '../../../application/commands/update-user-roles/update-user-roles.command.js';
import { GetUserByIdQuery } from '../../../application/queries/get-user-by-id/get-user-by-id.query.js';
import { GetUsersByIdsQuery } from '../../../application/queries/get-users-by-ids/get-users-by-ids.query.js';
import { ListUsersQuery } from '../../../application/queries/list-users/list-users.query.js';
import { AuthLocalAdapter } from './auth-local.adapter.js';
import { UsersLocalAdapter } from './users-local.adapter.js';

describe('local adapters (monolith: port → CQRS bus)', () => {
  let commandBus: ReturnType<typeof mockOf<CommandBus>>;
  let queryBus: ReturnType<typeof mockOf<QueryBus>>;

  beforeEach(() => {
    commandBus = mockOf<CommandBus>({ execute: async () => makeAuthTokens() });
    queryBus = mockOf<QueryBus>({ execute: async () => makeUser() });
  });

  it('AuthLocalAdapter dispatches one command per flow', async () => {
    const adapter = new AuthLocalAdapter(commandBus);
    await adapter.register({ email: 'e@x.io', password: 'p', displayName: 'd' });
    await adapter.login({ email: 'e@x.io', password: 'p', client: { ip: '1' } });
    await adapter.refreshTokens({ refreshToken: 'r' });
    await adapter.logout({ userId: 'u', accessTokenJti: 'j', accessTokenExp: '42' });

    const commands = commandBus.execute.mock.calls.map(([command]) => command);
    expect(commands[0]).toBeInstanceOf(RegisterUserCommand);
    expect(commands[1]).toEqual(new LoginCommand('e@x.io', 'p', { ip: '1' }));
    expect(commands[2]).toEqual(new RefreshSessionCommand('r', undefined));
    expect(commands[3]).toEqual(new LogoutCommand('u', 'j', 42, undefined));
  });

  it('UsersLocalAdapter routes reads to the QueryBus and writes to the CommandBus', async () => {
    const adapter = new UsersLocalAdapter(queryBus, commandBus);
    await adapter.getUser('u-1');
    await adapter.getUsersByIds(['u-1', 'u-2']);
    await adapter.listUsers({ limit: 10, search: 'ada' });
    await adapter.updateUserRoles({ id: 'u-1', roles: ['admin'], actorId: 'a' });

    expect(queryBus.execute.mock.calls.map(([query]) => query)).toEqual([
      new GetUserByIdQuery('u-1'),
      new GetUsersByIdsQuery(['u-1', 'u-2']),
      new ListUsersQuery(10, undefined, 'ada'),
    ]);
    expect(commandBus.execute).toHaveBeenCalledWith(
      new UpdateUserRolesCommand('u-1', ['admin'], 'a'),
    );
  });
});
