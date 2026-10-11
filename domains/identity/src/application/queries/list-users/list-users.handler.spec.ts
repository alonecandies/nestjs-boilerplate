import { beforeEach, describe, expect, it } from 'vitest';
import { makeUserRecord } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import type { UsersRepository } from '../../persistence/users.repository.js';
import { ListUsersHandler } from './list-users.handler.js';
import { ListUsersQuery } from './list-users.query.js';

describe('ListUsersHandler', () => {
  const user = makeUserRecord();
  let users: ReturnType<typeof mockOf<UsersRepository>>;
  let handler: ListUsersHandler;

  beforeEach(() => {
    users = mockOf<UsersRepository>({
      list: async () => ({ items: [user], nextCursor: 'next' }),
    });
    handler = new ListUsersHandler(users);
  });

  it('passes a clamped limit, the cursor and the trimmed search to the repository', async () => {
    const page = await handler.execute(new ListUsersQuery(500, 'cur', '  ada  '));
    expect(users.list).toHaveBeenCalledWith({ limit: 100, cursor: 'cur', search: 'ada' });
    expect(page).toEqual({ items: [expect.objectContaining({ id: user.id })], nextCursor: 'next' });
  });

  it('treats gRPC defaults (0, empty strings) as "not set"', async () => {
    await handler.execute(new ListUsersQuery(0, '', '   '));
    expect(users.list).toHaveBeenCalledWith({ limit: 20, cursor: undefined, search: undefined });
  });

  it('omits nextCursor on the last page (contract: absent, not null)', async () => {
    users.list.mockResolvedValue({ items: [], nextCursor: null });
    const page = await handler.execute(new ListUsersQuery());
    expect(page).toEqual({ items: [] });
    expect(page).not.toHaveProperty('nextCursor');
  });
});
