import { describe, expect, it } from 'vitest';
import { assertCanAssignRoles, assertCanRemove, parseTenantRoles } from './member-roles.policy.js';

describe('member roles policy', () => {
  it.each([[[]], [['root']], [['admin', 'admin']], [['owner', 7]]])(
    'parseTenantRoles rejects %j',
    (values) => {
      expect(() => parseTenantRoles(values)).toThrow(
        expect.objectContaining({ code: 'INVALID_ROLES' }),
      );
    },
  );

  it('parseTenantRoles returns canonical order', () => {
    expect(parseTenantRoles(['member', 'owner'])).toEqual(['owner', 'member']);
  });

  it('a member cannot change roles (FORBIDDEN)', () => {
    expect(() => assertCanAssignRoles(['member'], ['member'], ['admin'])).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('an admin manages admins and members, but needs owner rank to grant or revoke owner', () => {
    expect(() => assertCanAssignRoles(['admin'], ['member'], ['admin'])).not.toThrow();
    expect(() => assertCanAssignRoles(['admin'], ['member'], ['owner'])).toThrow(
      expect.objectContaining({ code: 'OWNER_RANK_REQUIRED' }),
    );
    expect(() => assertCanAssignRoles(['admin'], ['owner'], ['admin'])).toThrow(
      expect.objectContaining({ code: 'OWNER_RANK_REQUIRED' }),
    );
    expect(() => assertCanAssignRoles(['owner'], ['owner'], ['admin'])).not.toThrow();
  });

  it('removing an owner needs owner rank', () => {
    expect(() => assertCanRemove(['admin'], ['member'])).not.toThrow();
    expect(() => assertCanRemove(['admin'], ['owner'])).toThrow(
      expect.objectContaining({ code: 'OWNER_RANK_REQUIRED' }),
    );
    expect(() => assertCanRemove(['member'], ['member'])).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});
