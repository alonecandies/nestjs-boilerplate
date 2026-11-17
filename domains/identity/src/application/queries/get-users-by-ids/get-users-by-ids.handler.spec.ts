import {
  createPrincipal,
  DomainValidationException,
  generateId,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import { shuffle, times } from 'lodash-es';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeUserRecord } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import type { UserRecord, UsersRepository } from '../../persistence/users.repository.js';
import type { UsersSystemRepository } from '../../persistence/users.system-repository.js';
import { GetUsersByIdsHandler } from './get-users-by-ids.handler.js';
import { GetUsersByIdsQuery } from './get-users-by-ids.query.js';

const TENANT = '0190f3b2-0000-7000-8000-0000000000aa';

describe('GetUsersByIdsHandler', () => {
  const [a, b, c] = times(3, () => makeUserRecord()) as [UserRecord, UserRecord, UserRecord];
  let users: ReturnType<typeof mockOf<UsersRepository>>;
  let usersSystem: ReturnType<typeof mockOf<UsersSystemRepository>>;
  let reasons: (string | undefined)[];
  let handler: GetUsersByIdsHandler;
  /** The caller acting in TENANT (the DataLoader runs under the request's principal). */
  const inTenant = <T>(work: () => Promise<T>, tenantId: string | null = TENANT): Promise<T> =>
    runWithPrincipal(
      tenantId === null
        ? createPrincipal({ userId: a.id, tenantId: null })
        : createPrincipal({ userId: a.id, tenantId, roles: ['admin'] }),
      work,
    );

  beforeEach(() => {
    reasons = [];
    // The DB returns rows in any order.
    users = mockOf<UsersRepository>({ findByIds: async () => [a] });
    usersSystem = mockOf<UsersSystemRepository>({
      findByIdsInTenant: async () => {
        reasons.push(SystemContext.current()?.reason);
        return shuffle([a, b, c]);
      },
    });
    handler = new GetUsersByIdsHandler(users, usersSystem);
  });

  it("issues ONE system read of the caller's tenant for the deduplicated ids, in request order", async () => {
    const missing = generateId();
    const result = await inTenant(() =>
      handler.execute(new GetUsersByIdsQuery([c.id, a.id, missing, c.id, b.id])),
    );

    expect(usersSystem.findByIdsInTenant).toHaveBeenCalledOnce();
    expect(usersSystem.findByIdsInTenant).toHaveBeenCalledWith([c.id, a.id, missing, b.id], TENANT);
    expect(reasons).toEqual(['identity.user-directory']);
    expect(users.findByIds).not.toHaveBeenCalled();
    expect(result.map((user) => user.id)).toEqual([c.id, a.id, b.id]);
  });

  it('a principal without a tenant reads on the runtime path (its own row only)', async () => {
    const result = await inTenant(
      () => handler.execute(new GetUsersByIdsQuery([b.id, a.id])),
      null,
    );
    expect(users.findByIds).toHaveBeenCalledExactlyOnceWith([b.id, a.id]);
    expect(usersSystem.findByIdsInTenant).not.toHaveBeenCalled();
    expect(result.map((user) => user.id)).toEqual([a.id]);
  });

  it('drops non-uuid ids and skips the query when nothing is left', async () => {
    await expect(
      inTenant(() => handler.execute(new GetUsersByIdsQuery(['nope', '']))),
    ).resolves.toEqual([]);
    expect(usersSystem.findByIdsInTenant).not.toHaveBeenCalled();
    expect(users.findByIds).not.toHaveBeenCalled();
  });

  it('rejects batches above the limit', async () => {
    const ids = times(501, () => generateId());
    await expect(
      inTenant(() => handler.execute(new GetUsersByIdsQuery(ids))),
    ).rejects.toBeInstanceOf(DomainValidationException);
  });
});
