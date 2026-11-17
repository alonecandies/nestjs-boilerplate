import { createPrincipal, generateId, runWithPrincipal, type TenantRole } from '@platform/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { principalLog } from '../../../../test/principal-log.js';
import { createInMemoryIdentityPersistence } from '../../../testing/in-memory-identity.js';
import { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { RenameTenantCommand } from './rename-tenant.command.js';
import { RenameTenantHandler } from './rename-tenant.handler.js';

describe('RenameTenantHandler', () => {
  let persistence: ReturnType<typeof createInMemoryIdentityPersistence>;
  let handler: RenameTenantHandler;
  let log: ReturnType<typeof principalLog>;
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
    log = principalLog();
    handler = new RenameTenantHandler(
      log.track('tenants', persistence.tenants),
      persistence.memberships,
      persistence.transactions,
      new TenantAuditLog(persistence.auditEvents),
      log.track('elevation', persistence.elevation),
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
  it('elevates with tenant:manage first in its unit of work, before any repository call there', async () => {
    await as(owner, ['owner'], 'Acme Labs');
    const calls = log.calls.map((c) => c.call);
    const elevate = calls.indexOf('elevation.elevate');
    expect(elevate).toBeGreaterThan(-1);
    expect(calls.indexOf('tenants.findById')).toBeGreaterThan(elevate);
    expect(persistence.elevation.calls[0]).toMatchObject({
      kind: 'permission',
      name: 'tenant:manage',
    });
    // Only reads of the actor's own roles may run before (as the request principal, outside it).
    expect(calls.slice(0, elevate).every((c) => c === 'memberships.find')).toBe(true);
    expect(log.calls.every((c) => c.principal?.tenantId === tenantId)).toBe(true);
  });

  it('an UPDATE the policies hide (0 rows) is 404 Tenant, with no audit row', async () => {
    vi.spyOn(persistence.tenants, 'rename').mockResolvedValue(false);
    await expect(as(owner, ['owner'], 'Acme Labs')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { entity: 'Tenant', id: tenantId },
    });
    expect(persistence.store.auditEvents).toEqual([]);
  });
});
