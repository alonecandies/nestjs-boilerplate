import { describe, expect, it } from 'vitest';
import { UnauthenticatedException } from '../errors/domain.exception.js';
import { isPlatformTenantId, PLATFORM_TENANT_ID } from './platform-tenant.js';
import { createPrincipal, isPrincipal, TenancyErrorCode } from './principal.js';

const USER = '0190f3b2-0000-7000-8000-000000000001';
const TENANT = '0190f3b2-0000-7000-8000-0000000000aa';

const errorOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('PLATFORM_TENANT_ID', () => {
  it('is the nil UUID', () => {
    expect(PLATFORM_TENANT_ID).toBe('00000000-0000-0000-0000-000000000000');
    expect(isPlatformTenantId(PLATFORM_TENANT_ID)).toBe(true);
    expect(isPlatformTenantId(TENANT)).toBe(false);
    expect(isPlatformTenantId(undefined)).toBe(false);
  });
});

describe('createPrincipal', () => {
  it('builds a frozen tenant principal with normalized roles', () => {
    const principal = createPrincipal({
      userId: USER,
      tenantId: TENANT,
      roles: ['member', 'owner', 'ghost', 'member'],
    });
    expect(principal).toEqual({
      userId: USER,
      tenantId: TENANT,
      roles: ['owner', 'member'],
      staff: false,
    });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.roles)).toBe(true);
    expect(isPrincipal(principal)).toBe(true);
  });

  it('builds a user-scoped principal (no tenant, no roles, never staff)', () => {
    expect(createPrincipal({ userId: USER, tenantId: null })).toEqual({
      userId: USER,
      tenantId: null,
      roles: [],
      staff: false,
    });
  });

  it('keeps staff only as the boolean true, and only with a tenant', () => {
    expect(
      createPrincipal({ userId: USER, tenantId: TENANT, roles: ['admin'], staff: true }).staff,
    ).toBe(true);
    expect(
      errorOf(() => createPrincipal({ userId: USER, tenantId: null, staff: true })),
    ).toMatchObject({
      code: TenancyErrorCode.INVALID_PRINCIPAL,
      details: { reason: 'roles and staff need a tenant' },
    });
  });

  it.each([
    ['a malformed user id', { userId: 'u-1', tenantId: TENANT }, 'userId is not a UUID'],
    ['the nil user id', { userId: PLATFORM_TENANT_ID, tenantId: TENANT }, 'userId is not a UUID'],
    [
      'a malformed tenant id',
      { userId: USER, tenantId: "x'; drop table t; --" },
      'tenantId is not a UUID',
    ],
    [
      'the platform tenant',
      { userId: USER, tenantId: PLATFORM_TENANT_ID },
      'tenantId is the platform tenant',
    ],
    [
      'roles without a tenant',
      { userId: USER, tenantId: null, roles: ['owner'] },
      'roles and staff need a tenant',
    ],
  ])('refuses %s with 401 INVALID_PRINCIPAL', (_name, input, reason) => {
    const error = errorOf(() => createPrincipal(input));
    expect(error).toBeInstanceOf(UnauthenticatedException);
    expect(error).toMatchObject({ code: 'INVALID_PRINCIPAL', details: { reason } });
  });
});

describe('isPrincipal', () => {
  it('rejects anything that createPrincipal would not produce', () => {
    expect(isPrincipal(undefined)).toBe(false);
    expect(isPrincipal({ userId: USER, tenantId: TENANT, roles: ['root'], staff: false })).toBe(
      false,
    );
    expect(isPrincipal({ userId: USER, tenantId: TENANT, roles: [], staff: 'yes' })).toBe(false);
    expect(isPrincipal({ userId: 'u', tenantId: null, roles: [], staff: false })).toBe(false);
    expect(
      isPrincipal({ userId: PLATFORM_TENANT_ID, tenantId: TENANT, roles: [], staff: false }),
    ).toBe(false);
    expect(
      isPrincipal({ userId: USER, tenantId: PLATFORM_TENANT_ID, roles: [], staff: false }),
    ).toBe(false);
    expect(isPrincipal({ userId: USER, tenantId: null, roles: ['owner'], staff: false })).toBe(
      false,
    );
    expect(isPrincipal({ userId: USER, tenantId: null, roles: [], staff: true })).toBe(false);
    expect(
      isPrincipal({ userId: USER, tenantId: TENANT, roles: ['member', 'owner'], staff: false }),
    ).toBe(false);
    expect(isPrincipal(createPrincipal({ userId: USER, tenantId: null }))).toBe(true);
  });
});
