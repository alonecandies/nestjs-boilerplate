import { createTestRbacRegistry } from '@platform/auth/testing';
import { describe, expect, it } from 'vitest';
import { AI_RBAC, AiPermission } from './ai.permissions.js';

describe('AI_RBAC', () => {
  const rbac = createTestRbacRegistry(AI_RBAC);

  it('declares every AiPermission value', () => {
    expect(rbac.permissions()).toEqual(Object.values(AiPermission).sort());
  });

  it('grants ai:chat to members and above, and to no one without a role', () => {
    for (const role of ['member', 'admin', 'owner'] as const) {
      expect(rbac.resolve([role])).toEqual([AiPermission.Chat]);
    }
    expect(rbac.resolve([])).toEqual([]);
  });
});
