import { createPrincipal, runWithPrincipal } from '@platform/common';
import type { RlsElevation } from '@platform/database';
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
});
