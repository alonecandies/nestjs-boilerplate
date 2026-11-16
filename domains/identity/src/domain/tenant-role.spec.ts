import { TENANT_ROLES } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { TENANT_ROLE_VALUES } from './tenant-role.js';

describe('TENANT_ROLE_VALUES', () => {
  it('is @platform/common TENANT_ROLES (the identity.tenant_role enum values)', () => {
    expect([...TENANT_ROLE_VALUES]).toEqual([...TENANT_ROLES]);
  });
});
