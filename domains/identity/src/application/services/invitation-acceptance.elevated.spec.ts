import { createPrincipal, runWithPrincipal } from '@platform/common';
import type { RlsElevation } from '@platform/database';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockOf } from '../../../test/mocks.js';
import {
  InvitationInvalidException,
  MembershipAlreadyExistsException,
  TenantAccessDeniedException,
} from '../../domain/identity.errors.js';
import { createInMemoryIdentityPersistence } from '../../testing/in-memory-identity.js';
import type { InvitationRecord } from '../persistence/invitations.repository.js';
import { InvitationAcceptance } from './invitation-acceptance.elevated.js';
import { TenantAuditLog } from './tenant-audit-log.service.js';

const INVITEE = '0190f3b2-0000-7000-8000-000000000001';
const TENANT = '0190f3b2-0000-7000-8000-0000000000aa';
const NOW = new Date('2026-11-17T10:00:00.000Z');
const INVITATION: InvitationRecord = {
  tenantId: TENANT,
  id: '0190f3b2-0000-7000-8000-0000000000c1',
  email: 'ada@example.com',
  roles: ['member'],
  tokenHash: 'h'.repeat(64),
  invitedBy: '0190f3b2-0000-7000-8000-000000000009',
  expiresAt: new Date(NOW.getTime() + 86_400_000),
  acceptedAt: null,
  createdAt: NOW,
};

describe('InvitationAcceptance (justified: verified-invitation)', () => {
  let persistence: ReturnType<typeof createInMemoryIdentityPersistence>;
  let elevation: ReturnType<typeof mockOf<RlsElevation>>;
  let acceptance: InvitationAcceptance;
  let elevated = false;
  const writes: [string, boolean][] = [];

  beforeEach(async () => {
    persistence = createInMemoryIdentityPersistence();
    writes.length = 0;
    elevation = mockOf<RlsElevation>({
      justified: async (_reason: string, work: () => Promise<unknown>) => {
        elevated = true;
        try {
          return await work();
        } finally {
          elevated = false;
        }
      },
    });
    const { invitations, memberships, auditEvents } = persistence;
    for (const [name, target, method] of [
      ['markAccepted', invitations, 'markAccepted'],
      ['membership', memberships, 'insert'],
      ['audit', auditEvents, 'append'],
    ] as const) {
      const original = (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
        method
      ]?.bind(target);
      (target as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
        writes.push([name, elevated]);
        return original?.(...args);
      };
    }
    acceptance = new InvitationAcceptance(
      invitations,
      memberships,
      new TenantAuditLog(auditEvents),
      elevation,
    );
    await invitations.insert(INVITATION);
  });

  const asInvitee = createPrincipal({ userId: INVITEE, tenantId: TENANT, roles: ['member'] });

  it('marks it accepted, inserts the membership and the audit row, all inside verified-invitation', async () => {
    await runWithPrincipal(asInvitee, () => acceptance.accept(INVITATION, INVITEE, NOW));
    expect(elevation.justified).toHaveBeenCalledExactlyOnceWith(
      'verified-invitation',
      expect.any(Function),
    );
    expect(writes).toEqual([
      ['markAccepted', true],
      ['membership', true],
      ['audit', true],
    ]);
    await expect(persistence.memberships.find(TENANT, INVITEE)).resolves.toMatchObject({
      roles: ['member'],
    });
    expect(persistence.store.auditEvents).toContainEqual(
      expect.objectContaining({ type: 'invitation.accepted', actorId: INVITEE, tenantId: TENANT }),
    );
  });

  it('409 for an existing member, 404 when a concurrent accept won', async () => {
    await persistence.memberships.insert({
      tenantId: TENANT,
      userId: INVITEE,
      roles: ['admin'],
      lastActiveAt: null,
    });
    await expect(
      runWithPrincipal(asInvitee, () => acceptance.accept(INVITATION, INVITEE, NOW)),
    ).rejects.toBeInstanceOf(MembershipAlreadyExistsException);

    await persistence.memberships.delete(TENANT, INVITEE);
    await persistence.invitations.markAccepted(TENANT, INVITATION.id, NOW);
    await expect(
      runWithPrincipal(asInvitee, () => acceptance.accept(INVITATION, INVITEE, NOW)),
    ).rejects.toBeInstanceOf(InvitationInvalidException);
  });

  it.each([
    [
      'the invitee outside the invitation tenant',
      createPrincipal({ userId: INVITEE, tenantId: null }),
    ],
    [
      'another user',
      createPrincipal({ userId: '0190f3b2-0000-7000-8000-000000000002', tenantId: TENANT }),
    ],
    [
      'a staff switch-in',
      createPrincipal({ userId: INVITEE, tenantId: TENANT, roles: ['admin'], staff: true }),
    ],
  ])('refuses %s without elevating', async (_name, principal) => {
    await expect(
      runWithPrincipal(principal, () => acceptance.accept(INVITATION, INVITEE, NOW)),
    ).rejects.toBeInstanceOf(TenantAccessDeniedException);
    expect(elevation.justified).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});
