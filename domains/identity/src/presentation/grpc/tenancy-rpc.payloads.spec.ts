import { generateId, PLATFORM_TENANT_ID } from '@platform/common';
import { describe, expect, it } from 'vitest';
import {
  acceptInvitationRequestSchema,
  createInvitationRequestSchema,
  listMembersRequestSchema,
  updateMemberRolesRequestSchema,
} from './tenancy-rpc.payloads.js';

describe('tenancy RPC payloads', () => {
  const tenantId = generateId();
  const actorId = generateId();

  it('normalises proto-loader nulls and validates roles', () => {
    expect(listMembersRequestSchema.parse({ tenantId, limit: 0, cursor: null })).toEqual({
      tenantId,
      limit: 0,
    });
    expect(
      updateMemberRolesRequestSchema.safeParse({
        tenantId,
        actorId,
        userId: generateId(),
        roles: ['root'],
      }).success,
    ).toBe(false);
  });

  it('refuses the platform tenant and malformed ids', () => {
    expect(
      listMembersRequestSchema.safeParse({ tenantId: PLATFORM_TENANT_ID, limit: 1 }).success,
    ).toBe(false);
    expect(
      createInvitationRequestSchema.safeParse({
        tenantId,
        actorId: 'x',
        email: 'a@b.io',
        roles: ['member'],
      }).success,
    ).toBe(false);
  });

  it('normalises the invited email and checks the token shape', () => {
    expect(
      createInvitationRequestSchema.parse({
        tenantId,
        actorId,
        email: ' A@B.io ',
        roles: ['member'],
      }).email,
    ).toBe('a@b.io');
    expect(
      acceptInvitationRequestSchema.safeParse({ userId: actorId, token: 'short' }).success,
    ).toBe(false);
  });
});
