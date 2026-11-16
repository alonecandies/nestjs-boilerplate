import { describe, expect, it } from 'vitest';
import { authenticatedTenantId } from './throttle-tracker.util.js';

describe('authenticatedTenantId', () => {
  it('reads a non-empty tenantId structurally', () => {
    expect(authenticatedTenantId({ id: 'u', tenantId: 't-1' })).toBe('t-1');
    expect(authenticatedTenantId({ id: 'u', tenantId: '' })).toBeUndefined();
    expect(authenticatedTenantId({ id: 'u', tenantId: null })).toBeUndefined();
    expect(authenticatedTenantId(undefined)).toBeUndefined();
  });
});
