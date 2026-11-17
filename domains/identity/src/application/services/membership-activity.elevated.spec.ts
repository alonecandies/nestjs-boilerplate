import { createPrincipal, runWithPrincipal } from '@platform/common';
import { type RlsElevation, RowCountMismatchError } from '@platform/database';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockOf } from '../../../test/mocks.js';
import { TenantAccessDeniedException } from '../../domain/identity.errors.js';
import { createInMemoryIdentityPersistence } from '../../testing/in-memory-identity.js';
import { MembershipActivity } from './membership-activity.elevated.js';

const USER = '0190f3b2-0000-7000-8000-000000000001';
const TENANT = '0190f3b2-0000-7000-8000-0000000000aa';
const NOW = new Date('2026-11-17T10:00:00.000Z');

describe('MembershipActivity (justified: membership-activity)', () => {
  let persistence: ReturnType<typeof createInMemoryIdentityPersistence>;
  let elevation: ReturnType<typeof mockOf<RlsElevation>>;
  let activity: MembershipActivity;

  beforeEach(async () => {
    persistence = createInMemoryIdentityPersistence();
    elevation = mockOf<RlsElevation>({
      justified: async (_reason: string, work: () => Promise<unknown>) => work(),
    });
    activity = new MembershipActivity(persistence.memberships, elevation);
    await persistence.memberships.insert({
      tenantId: TENANT,
      userId: USER,
      roles: ['member'],
      lastActiveAt: null,
    });
  });

  it("touches the principal's own membership inside the membership-activity elevation", async () => {
    await runWithPrincipal(
      createPrincipal({ userId: USER, tenantId: TENANT, roles: ['member'] }),
      () => activity.touch(TENANT, USER, NOW),
    );
    expect(elevation.justified).toHaveBeenCalledExactlyOnceWith(
      'membership-activity',
      expect.any(Function),
    );
    await expect(persistence.memberships.find(TENANT, USER)).resolves.toMatchObject({
      lastActiveAt: NOW,
    });
  });

  it.each([
    ['no tenant (user-scoped)', createPrincipal({ userId: USER, tenantId: null })],
    [
      'another tenant',
      createPrincipal({ userId: USER, tenantId: '0190f3b2-0000-7000-8000-0000000000bb' }),
    ],
    [
      'another user',
      createPrincipal({ userId: '0190f3b2-0000-7000-8000-000000000002', tenantId: TENANT }),
    ],
  ])('refuses %s without elevating', async (_name, principal) => {
    await expect(
      runWithPrincipal(principal, () => activity.touch(TENANT, USER, NOW)),
    ).rejects.toBeInstanceOf(TenantAccessDeniedException);
    expect(elevation.justified).not.toHaveBeenCalled();
    await expect(persistence.memberships.find(TENANT, USER)).resolves.toMatchObject({
      lastActiveAt: null,
    });
  });

  it('a membership removed since it was read is TENANT_ACCESS_DENIED (403), not a row-count 500', async () => {
    await persistence.memberships.delete(TENANT, USER);
    const error = await runWithPrincipal(
      createPrincipal({ userId: USER, tenantId: TENANT, roles: ['member'] }),
      () => activity.touch(TENANT, USER, NOW),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenantAccessDeniedException);
    expect(error).toMatchObject({ httpStatus: 403, code: 'TENANT_ACCESS_DENIED' });
    expect((error as Error).cause).toBeInstanceOf(RowCountMismatchError);
  });

  it('any other failure of the touch passes through unchanged', async () => {
    const boom = new Error('connection reset');
    elevation.justified.mockRejectedValueOnce(boom);
    await expect(
      runWithPrincipal(createPrincipal({ userId: USER, tenantId: TENANT, roles: ['member'] }), () =>
        activity.touch(TENANT, USER, NOW),
      ),
    ).rejects.toBe(boom);
  });
});
