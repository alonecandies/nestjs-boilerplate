import { createPrincipal, generateId, runWithPrincipal, type TenantRole } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryIdentityPersistence } from '../../../testing/in-memory-identity.js';
import { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { RenameTenantCommand } from './rename-tenant.command.js';
import { RenameTenantHandler } from './rename-tenant.handler.js';

describe('RenameTenantHandler', () => {
  let persistence: ReturnType<typeof createInMemoryIdentityPersistence>;
  let handler: RenameTenantHandler;
  const tenantId = generateId();
  const owner = generateId();
  const admin = generateId();

  const as = (userId: string, roles: TenantRole[], name: string) =>
    runWithPrincipal(createPrincipal({ userId, tenantId, roles }), () =>
      handler.execute(new RenameTenantCommand(tenantId, userId, name)),
    );

  beforeEach(async () => {
    persistence = createInMemoryIdentityPersistence();
    await persistence.tenants.insert({
      id: tenantId,
      slug: `acme-${tenantId.slice(-8)}`,
      name: 'Acme',
      personal: false,
    });
    await persistence.memberships.insert({
      tenantId,
      userId: owner,
      roles: ['owner'],
      lastActiveAt: null,
    });
    await persistence.memberships.insert({
      tenantId,
      userId: admin,
      roles: ['admin'],
      lastActiveAt: null,
    });
    handler = new RenameTenantHandler(
      persistence.tenants,
      persistence.memberships,
      persistence.transactions,
      new TenantAuditLog(persistence.auditEvents),
    );
  });

  it('renames for an owner and audits tenant.renamed { from, to }', async () => {
    await expect(as(owner, ['owner'], ' Acme Labs ')).resolves.toMatchObject({
      id: tenantId,
      name: 'Acme Labs',
    });
    expect(persistence.store.auditEvents).toEqual([
      expect.objectContaining({
        tenantId,
        actorId: owner,
        type: 'tenant.renamed',
        data: { from: 'Acme', to: 'Acme Labs' },
      }),
    ]);
  });

  it('403 FORBIDDEN for an admin, even with a forged owner token (the membership decides)', async () => {
    await expect(as(admin, ['owner'], 'Hijacked')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(persistence.tenants.findById(tenantId)).resolves.toMatchObject({ name: 'Acme' });
  });
});
