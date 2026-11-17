import {
  createPrincipal,
  EntityNotFoundException,
  generateId,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import { describe, expect, it } from 'vitest';
import { makeUserRecord } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import type { UsersRepository } from '../../persistence/users.repository.js';
import type { UsersSystemRepository } from '../../persistence/users.system-repository.js';
import { GetUserByIdHandler } from './get-user-by-id.handler.js';
import { GetUserByIdQuery } from './get-user-by-id.query.js';

describe('GetUserByIdHandler', () => {
  it('returns the contract user', async () => {
    const user = makeUserRecord();
    const users = mockOf<UsersRepository>({ findById: async () => user });
    await expect(
      new GetUserByIdHandler(users, mockOf<UsersSystemRepository>()).execute(
        new GetUserByIdQuery(user.id),
      ),
    ).resolves.toEqual({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      roles: [],
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    });
  });

  it('throws EntityNotFoundException for an unknown id', async () => {
    const users = mockOf<UsersRepository>({ findById: async () => null });
    const id = generateId();
    await expect(
      new GetUserByIdHandler(users, mockOf<UsersSystemRepository>()).execute(
        new GetUserByIdQuery(id),
      ),
    ).rejects.toMatchObject({
      constructor: EntityNotFoundException,
      details: { entity: 'User', id },
    });
  });

  it('with a tenant: a system read in SystemContext; only a member of that tenant is found', async () => {
    const tenantId = '0190f3b2-0000-7000-8000-0000000000aa';
    const member = makeUserRecord();
    const users = mockOf<UsersRepository>({ findById: async () => member });
    const reasons: (string | undefined)[] = [];
    const usersSystem = mockOf<UsersSystemRepository>({
      findByIdInTenant: async (id: string) => {
        reasons.push(SystemContext.current()?.reason);
        return id === member.id ? member : null;
      },
    });
    const handler = new GetUserByIdHandler(users, usersSystem);
    const actingIn = (tenant: string) =>
      createPrincipal({ userId: generateId(), tenantId: tenant, roles: ['admin'] });
    const run = (query: GetUserByIdQuery, tenant = tenantId) =>
      runWithPrincipal(actingIn(tenant), () => handler.execute(query));
    await expect(run(new GetUserByIdQuery(member.id, tenantId))).resolves.toMatchObject({
      id: member.id,
    });
    expect(usersSystem.findByIdInTenant).toHaveBeenCalledWith(member.id, tenantId);
    expect(reasons).toEqual(['identity.user-directory']);
    await expect(
      run(new GetUserByIdQuery('0190f3b2-0000-7000-8000-00000000dead', tenantId)),
    ).rejects.toBeInstanceOf(EntityNotFoundException);
    // A caller acting in another tenant (or none) never reaches the system read.
    usersSystem.findByIdInTenant.mockClear();
    await expect(
      run(new GetUserByIdQuery(member.id, tenantId), generateId()),
    ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    await expect(handler.execute(new GetUserByIdQuery(member.id, tenantId))).rejects.toThrow();
    expect(usersSystem.findByIdInTenant).not.toHaveBeenCalled();
    expect(users.findById).not.toHaveBeenCalled();
  });
});
