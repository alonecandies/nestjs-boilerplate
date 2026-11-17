import { DomainValidationException, PLATFORM_TENANT_ID } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { requireEventTenant } from './event-tenant.js';

const TENANT_ID = '01920000-0000-7000-8000-0000000000ee';

describe('requireEventTenant', () => {
  it('returns the envelope tenant', () => {
    expect(requireEventTenant({ tenantId: TENANT_ID })).toBe(TENANT_ID);
  });

  it.each([
    ['absent', {}],
    ['undefined', { tenantId: undefined }],
    ['malformed', { tenantId: 'acme' }],
    ['the nil (platform) uuid', { tenantId: PLATFORM_TENANT_ID }],
  ])('throws a DomainValidationException when the tenant is %s', (_case, event) => {
    expect(() => requireEventTenant(event)).toThrow(DomainValidationException);
    expect(() => requireEventTenant(event)).toThrow(
      expect.objectContaining({ code: 'EVENT_TENANT_REQUIRED' }),
    );
  });
});
