import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { requireTenantPrincipal } from './tenant-scope.js';

describe('requireTenantPrincipal', () => {
  const userId = generateId();
  const tenantId = generateId();
  const asUser = <T>(fn: () => T): T =>
    runWithPrincipal(createPrincipal({ userId, tenantId, roles: ['member'] }), fn);

  it('returns the principal acting in the tenant (and as the user)', () => {
    expect(asUser(() => requireTenantPrincipal(tenantId, userId))).toMatchObject({
      userId,
      tenantId,
    });
    expect(asUser(() => requireTenantPrincipal(tenantId))).toMatchObject({ tenantId });
  });

  it('403 TENANT_MISMATCH for another tenant or another user', () => {
    expect(() => asUser(() => requireTenantPrincipal(generateId(), userId))).toThrow(
      expect.objectContaining({ code: 'TENANT_MISMATCH' }),
    );
    expect(() => asUser(() => requireTenantPrincipal(tenantId, generateId()))).toThrow(
      expect.objectContaining({ code: 'TENANT_MISMATCH' }),
    );
  });

  it('401 PRINCIPAL_MISSING without a principal', () => {
    expect(() => requireTenantPrincipal(tenantId, userId)).toThrow(
      expect.objectContaining({ code: 'PRINCIPAL_MISSING' }),
    );
  });
});
