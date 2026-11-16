import { EntityNotFoundException, generateId } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { makeUserRecord } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import type { UsersRepository } from '../../persistence/users.repository.js';
import { GetUserByIdHandler } from './get-user-by-id.handler.js';
import { GetUserByIdQuery } from './get-user-by-id.query.js';

describe('GetUserByIdHandler', () => {
  it('returns the contract user', async () => {
    const user = makeUserRecord();
    const users = mockOf<UsersRepository>({ findById: async () => user });
    await expect(
      new GetUserByIdHandler(users).execute(new GetUserByIdQuery(user.id)),
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
      new GetUserByIdHandler(users).execute(new GetUserByIdQuery(id)),
    ).rejects.toMatchObject({
      constructor: EntityNotFoundException,
      details: { entity: 'User', id },
    });
  });

  it('with a tenant: only a member of that tenant is found; anyone else is 404', async () => {
    const tenantId = '0190f3b2-0000-7000-8000-0000000000aa';
    const member = makeUserRecord();
    const users = mockOf<UsersRepository>({
      findById: async () => member,
      findByIdInTenant: async (id: string) => (id === member.id ? member : null),
    });
    const handler = new GetUserByIdHandler(users);
    await expect(handler.execute(new GetUserByIdQuery(member.id, tenantId))).resolves.toMatchObject(
      { id: member.id },
    );
    expect(users.findByIdInTenant).toHaveBeenCalledWith(member.id, tenantId);
    await expect(
      handler.execute(new GetUserByIdQuery('0190f3b2-0000-7000-8000-00000000dead', tenantId)),
    ).rejects.toBeInstanceOf(EntityNotFoundException);
    expect(users.findById).not.toHaveBeenCalled();
  });
});
