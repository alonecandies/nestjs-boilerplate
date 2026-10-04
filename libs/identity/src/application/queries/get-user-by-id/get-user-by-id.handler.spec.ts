import { EntityNotFoundException, generateId } from '@app/common';
import { describe, expect, it } from 'vitest';
import { makeUserRecord } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import type { UsersRepository } from '../../persistence/users.repository.js';
import { GetUserByIdHandler } from './get-user-by-id.handler.js';
import { GetUserByIdQuery } from './get-user-by-id.query.js';

describe('GetUserByIdHandler', () => {
  it('returns the contract user', async () => {
    const user = makeUserRecord({ roles: ['moderator'] });
    const users = mockOf<UsersRepository>({ findById: async () => user });
    await expect(
      new GetUserByIdHandler(users).execute(new GetUserByIdQuery(user.id)),
    ).resolves.toEqual({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      roles: ['moderator'],
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
});
