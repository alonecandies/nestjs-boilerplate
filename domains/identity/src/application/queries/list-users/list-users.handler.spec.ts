import {
  createPrincipal,
  DomainValidationException,
  generateId,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeUserRecord } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import type { UsersSystemRepository } from '../../persistence/users.system-repository.js';
import { ListUsersHandler } from './list-users.handler.js';
import { ListUsersQuery } from './list-users.query.js';

const TENANT = '0190f3b2-0000-7000-8000-0000000000aa';
/** The directory is read for a caller acting in the tenant (the gateway/HTTP edge binds it). */
const inTenant = <T>(work: () => Promise<T>, tenantId: string | null = TENANT): Promise<T> =>
  runWithPrincipal(createPrincipal({ userId: generateId(), tenantId }), work);

describe('ListUsersHandler', () => {
  const user = makeUserRecord();
  let users: ReturnType<typeof mockOf<UsersSystemRepository>>;
  let handler: ListUsersHandler;

  beforeEach(() => {
    users = mockOf<UsersSystemRepository>({
      listInTenant: async () => ({ items: [user], nextCursor: 'next' }),
    });
    handler = new ListUsersHandler(users);
  });

  it('passes a clamped limit, the cursor and the trimmed search to the repository', async () => {
    const page = await inTenant(() =>
      handler.execute(new ListUsersQuery(TENANT, 500, 'cur', '  ada  ')),
    );
    expect(users.listInTenant).toHaveBeenCalledWith({
      tenantId: TENANT,
      limit: 100,
      cursor: 'cur',
      search: 'ada',
    });
    expect(page).toEqual({ items: [expect.objectContaining({ id: user.id })], nextCursor: 'next' });
  });

  it('treats gRPC defaults (0, empty strings) as "not set"', async () => {
    await inTenant(() => handler.execute(new ListUsersQuery(TENANT, 0, '', '   ')));
    expect(users.listInTenant).toHaveBeenCalledWith({
      tenantId: TENANT,
      limit: 20,
      cursor: undefined,
      search: undefined,
    });
  });

  it('reads the directory on the system pool inside SystemContext (identity.user-directory)', async () => {
    let reason: string | undefined;
    users.listInTenant.mockImplementation(async () => {
      reason = SystemContext.current()?.reason;
      return { items: [], nextCursor: null };
    });
    await inTenant(() => handler.execute(new ListUsersQuery(TENANT)));
    expect(reason).toBe('identity.user-directory');
  });

  it('omits nextCursor on the last page (contract: absent, not null)', async () => {
    users.listInTenant.mockResolvedValue({ items: [], nextCursor: null });
    const page = await inTenant(() => handler.execute(new ListUsersQuery(TENANT)));
    expect(page).toEqual({ items: [] });
    expect(page).not.toHaveProperty('nextCursor');
  });

  it('refuses a caller not acting in the tenant, or without a principal, before any read', async () => {
    await expect(
      inTenant(() => handler.execute(new ListUsersQuery(TENANT)), generateId()),
    ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    await expect(
      inTenant(() => handler.execute(new ListUsersQuery(TENANT)), null),
    ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    await expect(handler.execute(new ListUsersQuery(TENANT))).rejects.toThrow();
    expect(users.listInTenant).not.toHaveBeenCalled();
  });

  it('refuses a missing or malformed tenant (the directory is never global)', async () => {
    await expect(handler.execute(new ListUsersQuery('', 5))).rejects.toBeInstanceOf(
      DomainValidationException,
    );
    await expect(handler.execute(new ListUsersQuery('nope', 5))).rejects.toBeInstanceOf(
      DomainValidationException,
    );
    expect(users.listInTenant).not.toHaveBeenCalled();
  });
});
