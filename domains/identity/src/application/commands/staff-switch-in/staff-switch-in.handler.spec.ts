import { RbacErrorCode } from '@platform/auth';
import {
  DomainValidationException,
  EntityNotFoundException,
  PLATFORM_TENANT_ID,
} from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeUserRecord } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import { NotPlatformStaffException } from '../../../domain/identity.errors.js';
import type { TokenIssuer } from '../../../infrastructure/security/token-issuer.service.js';
import { AUDIT_EVENT_TYPES } from '../../persistence/audit-events.repository.js';
import type { TenantsRepository } from '../../persistence/tenants.repository.js';
import type { UsersRepository } from '../../persistence/users.repository.js';
import type { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { StaffSwitchInCommand } from './staff-switch-in.command.js';
import { StaffSwitchInHandler } from './staff-switch-in.handler.js';

const TENANT = '0190f3b2-0000-7000-8000-0000000000aa';

describe('StaffSwitchInHandler', () => {
  const staff = makeUserRecord({ isPlatformStaff: true });
  const log: string[] = [];
  let users: ReturnType<typeof mockOf<UsersRepository>>;
  let tenants: ReturnType<typeof mockOf<TenantsRepository>>;
  let issuer: ReturnType<typeof mockOf<TokenIssuer>>;
  let audit: ReturnType<typeof mockOf<TenantAuditLog>>;
  let handler: StaffSwitchInHandler;

  beforeEach(() => {
    log.length = 0;
    users = mockOf<UsersRepository>({
      isPlatformStaff: async () => true,
      findById: async () => staff,
    });
    tenants = mockOf<TenantsRepository>({
      findById: async (id: string) =>
        id === TENANT
          ? { id: TENANT, slug: 'acme', name: 'Acme', personal: false, createdAt: new Date() }
          : null,
    });
    issuer = mockOf<TokenIssuer>({
      issueAccessToken: async () => {
        log.push('sign');
        return { token: 'staff-jwt', jti: 'staff-jti', expiresIn: 300, exp: 1_900_000_000 };
      },
    });
    audit = mockOf<TenantAuditLog>({
      record: async () => {
        log.push('audit');
        return 'audit-1';
      },
    });
    handler = new StaffSwitchInHandler(users, tenants, issuer, audit, { ttlSec: 300 });
  });

  it('issues an admin + staff access token in the tenant, for the configured TTL, and audits it', async () => {
    const result = await handler.execute(
      new StaffSwitchInCommand(staff.id, TENANT, '  ticket #42: billing bug  ', {
        ip: '10.0.0.7',
        userAgent: 'curl',
      }),
    );
    expect(result).toEqual({
      accessToken: 'staff-jwt',
      expiresIn: 300,
      tokenType: 'Bearer',
      tenantId: TENANT,
      auditEventId: 'audit-1',
    });
    expect(issuer.issueAccessToken).toHaveBeenCalledWith(
      { id: staff.id, email: staff.email, tenantId: TENANT, roles: ['admin'], staff: true },
      { ttlSec: 300 },
    );
    expect(audit.record).toHaveBeenCalledWith({
      tenantId: TENANT,
      actorId: staff.id,
      type: AUDIT_EVENT_TYPES.STAFF_SWITCH_IN,
      data: {
        reason: 'ticket #42: billing bug',
        accessTokenJti: 'staff-jti',
        expiresAt: new Date(1_900_000_000_000).toISOString(),
        ip: '10.0.0.7',
        userAgent: 'curl',
      },
    });
    expect(log).toEqual(['sign', 'audit']);
  });

  it('403 STAFF_ONLY when the flag is not (or no longer) set: a fresh read, never the token', async () => {
    users.isPlatformStaff.mockResolvedValue(false);
    const error = await handler
      .execute(new StaffSwitchInCommand(staff.id, TENANT, 'x'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotPlatformStaffException);
    expect((error as NotPlatformStaffException).code).toBe(RbacErrorCode.STAFF_ONLY);
    expect(log).toEqual([]);
  });

  it.each([
    ['an unknown tenant', '0190f3b2-0000-7000-8000-00000000dead'],
    ['the platform tenant (nil UUID)', PLATFORM_TENANT_ID],
  ])('404 for %s, nothing signed or audited', async (_name, tenantId) => {
    await expect(
      handler.execute(new StaffSwitchInCommand(staff.id, tenantId, 'x')),
    ).rejects.toBeInstanceOf(EntityNotFoundException);
    expect(log).toEqual([]);
  });

  it.each([['   '], ['x'.repeat(1_001)]])(
    'rejects the reason %j (1..1000 characters after trimming)',
    async (reason) => {
      await expect(
        handler.execute(new StaffSwitchInCommand(staff.id, TENANT, reason)),
      ).rejects.toBeInstanceOf(DomainValidationException);
      expect(log).toEqual([]);
    },
  );
});
