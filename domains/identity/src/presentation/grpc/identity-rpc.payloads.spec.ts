import { describe, expect, it } from 'vitest';
import { IDENTITY_LIMITS } from '../../identity.constants.js';
import {
  getUserRequestSchema,
  listUsersRequestSchema,
  loginRequestSchema,
  switchTenantRequestSchema,
} from './identity-rpc.payloads.js';

describe('listUsersRequestSchema.search', () => {
  const parse = (search: string | null | undefined) =>
    listUsersRequestSchema.safeParse({
      limit: 0,
      search,
      tenantId: '0190f3b2-0000-7000-8000-0000000000aa',
    });

  it('trims; blank / null / absent → undefined (no filter)', () => {
    expect(parse(' ada ').data?.search).toBe('ada');
    for (const blank of ['', '   ', null, undefined]) {
      const result = parse(blank);
      expect(result.success).toBe(true);
      expect(result.data?.search).toBeUndefined();
    }
  });

  it(`rejects terms shorter than ${IDENTITY_LIMITS.SEARCH_MIN_LENGTH} (trigram index) or too long`, () => {
    expect(parse(' ab ').success).toBe(false);
    expect(parse('x'.repeat(IDENTITY_LIMITS.SEARCH_MAX_LENGTH + 1)).success).toBe(false);
    expect(parse('x'.repeat(IDENTITY_LIMITS.SEARCH_MAX_LENGTH)).success).toBe(true);
  });
});

describe('loginRequestSchema.tenantId', () => {
  const parse = (tenantId: unknown) =>
    loginRequestSchema.safeParse({ email: 'ada@example.com', password: 'pw', tenantId });

  it('absent, null or "" (proto3 unset optional) → undefined', () => {
    for (const unset of [undefined, null, '']) {
      const result = parse(unset);
      expect(result.success).toBe(true);
      expect(result.data?.tenantId).toBeUndefined();
    }
  });

  it('a UUID passes through (the nil UUID too: the handler answers it with 403, like any foreign tenant)', () => {
    expect(parse('0190f3b2-0000-7000-8000-0000000000aa').data?.tenantId).toBe(
      '0190f3b2-0000-7000-8000-0000000000aa',
    );
    expect(parse('00000000-0000-0000-0000-000000000000').success).toBe(true);
  });

  it('rejects malformed ids (INVALID_ARGUMENT before any handler runs)', () => {
    for (const bad of ['nope', '0190f3b2-0000-7000-8000-0000000000aa; drop', 42]) {
      expect(parse(bad).success).toBe(false);
    }
  });
});

describe('tenant scoping of the user RPCs', () => {
  it('ListUsers requires a tenant_id UUID', () => {
    expect(listUsersRequestSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(listUsersRequestSchema.safeParse({ limit: 0, tenantId: 'x' }).success).toBe(false);
  });

  it('GetUser takes an optional tenant_id UUID ("" and null = unscoped)', () => {
    const id = '0190f3b2-0000-7000-8000-000000000001';
    expect(getUserRequestSchema.parse({ id, tenantId: '' }).tenantId).toBeUndefined();
    expect(getUserRequestSchema.parse({ id, tenantId: null }).tenantId).toBeUndefined();
    expect(getUserRequestSchema.safeParse({ id, tenantId: 'x' }).success).toBe(false);
  });
});

describe('switchTenantRequestSchema', () => {
  const valid = {
    userId: '0190f3b2-0000-7000-8000-000000000001',
    tenantId: '0190f3b2-0000-7000-8000-0000000000a2',
    refreshToken: 'r',
    accessTokenJti: 'j',
    accessTokenExp: '1900000000',
    client: null,
  };
  it('accepts a full request (client null → undefined)', () => {
    expect(switchTenantRequestSchema.parse(valid).client).toBeUndefined();
  });
  it.each([
    ['tenantId', 'x'],
    ['userId', 'x'],
    ['accessTokenExp', 'soon'],
    ['refreshToken', ''],
  ])('rejects a bad %s', (field, value) => {
    expect(switchTenantRequestSchema.safeParse({ ...valid, [field]: value }).success).toBe(false);
  });
});
