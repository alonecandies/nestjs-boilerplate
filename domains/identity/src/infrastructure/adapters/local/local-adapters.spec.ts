import type { CommandBus, QueryBus } from '@nestjs/cqrs';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeAuthTokens, makeUser } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import { LoginCommand } from '../../../application/commands/login/login.command.js';
import { LogoutCommand } from '../../../application/commands/logout/logout.command.js';
import { RefreshSessionCommand } from '../../../application/commands/refresh-session/refresh-session.command.js';
import { RegisterUserCommand } from '../../../application/commands/register-user/register-user.command.js';
import { StaffSwitchInCommand } from '../../../application/commands/staff-switch-in/staff-switch-in.command.js';
import { SwitchTenantCommand } from '../../../application/commands/switch-tenant/switch-tenant.command.js';
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
    await adapter.switchTenant({
      userId: 'u',
      tenantId: 't',
      refreshToken: 'r',
      accessTokenJti: 'j',
      accessTokenExp: '42',
    });
    await adapter.staffSwitchIn({ staffUserId: 's', tenantId: 't', reason: 'r' });

    const commands = commandBus.execute.mock.calls.map(([command]) => command);
    expect(commands[0]).toBeInstanceOf(RegisterUserCommand);
    expect(commands[1]).toEqual(new LoginCommand('e@x.io', 'p', { ip: '1' }));
    expect(commands[2]).toEqual(new RefreshSessionCommand('r', undefined));
    expect(commands[3]).toEqual(new LogoutCommand('u', 'j', 42, undefined));
    expect(commands[4]).toEqual(
      new SwitchTenantCommand('u', 't', 'r', { jti: 'j', exp: 42 }, undefined),
    );
    expect(commands[5]).toEqual(new StaffSwitchInCommand('s', 't', 'r', undefined));
  });

  it('UsersLocalAdapter routes every read to the QueryBus', async () => {
    const adapter = new UsersLocalAdapter(queryBus);
    await adapter.getUser('u-1');
    await adapter.getUser('u-1', { tenantId: 't' });
    await adapter.getUsersByIds(['u-1', 'u-2']);
    await adapter.listUsers({ limit: 10, search: 'ada', tenantId: 't' });

    expect(queryBus.execute.mock.calls.map(([query]) => query)).toEqual([
      new GetUserByIdQuery('u-1', undefined),
      new GetUserByIdQuery('u-1', 't'),
      new GetUsersByIdsQuery(['u-1', 'u-2']),
      new ListUsersQuery('t', 10, undefined, 'ada'),
    ]);
    expect(commandBus.execute).not.toHaveBeenCalled();
  });
});
