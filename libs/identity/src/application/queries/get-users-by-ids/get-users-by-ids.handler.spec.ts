import { DomainValidationException, generateId } from '@app/common';
import { shuffle, times } from 'lodash-es';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeUserRecord } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import type { UserRecord, UsersRepository } from '../../persistence/users.repository.js';
import { GetUsersByIdsHandler } from './get-users-by-ids.handler.js';
import { GetUsersByIdsQuery } from './get-users-by-ids.query.js';

describe('GetUsersByIdsHandler', () => {
  const [a, b, c] = times(3, () => makeUserRecord()) as [UserRecord, UserRecord, UserRecord];
  let users: ReturnType<typeof mockOf<UsersRepository>>;
  let handler: GetUsersByIdsHandler;

  beforeEach(() => {
    // The DB returns rows in any order.
    users = mockOf<UsersRepository>({ findByIds: async () => shuffle([a, b, c]) });
    handler = new GetUsersByIdsHandler(users);
  });

  it('issues ONE lookup for the deduplicated ids and preserves the request order', async () => {
    const missing = generateId();
    const result = await handler.execute(new GetUsersByIdsQuery([c.id, a.id, missing, c.id, b.id]));

    expect(users.findByIds).toHaveBeenCalledOnce();
    expect(users.findByIds).toHaveBeenCalledWith([c.id, a.id, missing, b.id]);
    expect(result.map((user) => user.id)).toEqual([c.id, a.id, b.id]);
  });

  it('drops non-uuid ids and skips the query when nothing is left', async () => {
    await expect(handler.execute(new GetUsersByIdsQuery(['nope', '']))).resolves.toEqual([]);
    expect(users.findByIds).not.toHaveBeenCalled();
  });

  it('rejects batches above the limit', async () => {
    const ids = times(501, () => generateId());
    await expect(handler.execute(new GetUsersByIdsQuery(ids))).rejects.toBeInstanceOf(
      DomainValidationException,
    );
  });
});
