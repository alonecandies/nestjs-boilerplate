import { createTestRbacRegistry, makeAuthUser } from '@platform/auth/testing';
import { DomainValidationException, generateId } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { FILES_RBAC, FilesPermission } from '../files.permissions.js';
import { resolveFileAccess } from './file-access.policy.js';
import type { FileAccess, FileActor } from './files.types.js';

describe('resolveFileAccess', () => {
  const rbac = createTestRbacRegistry(FILES_RBAC);
  const tenantA = generateId();
  const tenantB = generateId();
  const userId = generateId();
  const otherId = generateId();

  const member = (id: string, tenantId: string): FileActor =>
    makeAuthUser({ id, tenantId, roles: ['member'] }, rbac);
  const manager = (id: string, tenantId: string): FileActor =>
    makeAuthUser({ id, tenantId, roles: ['admin'] }, rbac);

  const fileOf = (tenantId: string, ownerId: string): string =>
    `tenants/${tenantId}/users/${ownerId}/${generateId()}/a.txt`;

  // A tenant id that extends A's by one character (still one segment, not a UUID).
  const extendedA = `${tenantA}0`;

  it.each<[string, FileActor, string, FileAccess]>([
    ['own key', member(userId, tenantA), fileOf(tenantA, userId), 'owner'],
    ['own key, also with files:manage', manager(userId, tenantA), fileOf(tenantA, userId), 'owner'],
    [
      'same tenant, other user, without files:manage',
      member(userId, tenantA),
      fileOf(tenantA, otherId),
      'denied',
    ],
    [
      'same tenant, other user, with files:manage',
      manager(userId, tenantA),
      fileOf(tenantA, otherId),
      'manager',
    ],
    [
      "the same user's key in tenant B while acting in A",
      member(userId, tenantA),
      fileOf(tenantB, userId),
      'denied',
    ],
    [
      "the same user's key in tenant B while acting in A, with files:manage",
      manager(userId, tenantA),
      fileOf(tenantB, userId),
      'denied',
    ],
    [
      "another user's key in tenant B, with files:manage in A",
      manager(userId, tenantA),
      fileOf(tenantB, otherId),
      'denied',
    ],
    [
      'legacy users/<U>/x, for its uploader',
      member(userId, tenantA),
      `users/${userId}/x`,
      'denied',
    ],
    ['legacy users/<U>/x, for a manager', manager(otherId, tenantA), `users/${userId}/x`, 'denied'],
    ['the bare tenant prefix', manager(userId, tenantA), `tenants/${tenantA}`, 'denied'],
    [
      'the bare user prefix, for that user',
      member(userId, tenantA),
      `tenants/${tenantA}/users/${userId}`,
      'denied',
    ],
    [
      "a tenant id that extends A's by one character, for its user",
      member(userId, tenantA),
      `tenants/${extendedA}/users/${userId}/x.txt`,
      'denied',
    ],
    [
      "a tenant id that extends A's by one character, for a manager",
      manager(otherId, tenantA),
      `tenants/${extendedA}/users/${userId}/x.txt`,
      'denied',
    ],
    [
      'a user id that extends the actor id by one character',
      member(userId, tenantA),
      `tenants/${tenantA}/users/${userId}0/x.txt`,
      'denied',
    ],
  ])('%s → %s', (_case, actor, key, expected) => {
    expect(resolveFileAccess(actor, key)).toBe(expected);
  });

  it('grants files:manage from the permission, not from the role name', () => {
    const key = fileOf(tenantA, otherId);
    const actor: FileActor = {
      id: userId,
      tenantId: tenantA,
      permissions: [FilesPermission.Manage],
    };
    expect(resolveFileAccess(actor, key)).toBe('manager');
    expect(resolveFileAccess({ ...actor, permissions: [] }, key)).toBe('denied');
  });

  it('validates the key first: a traversal is INVALID_STORAGE_KEY for everyone', () => {
    const traversal = `tenants/${tenantA}/../${tenantB}/users/${userId}/x.txt`;
    for (const actor of [member(userId, tenantA), manager(otherId, tenantA)]) {
      expect(() => resolveFileAccess(actor, traversal)).toThrow(DomainValidationException);
      expect(() => resolveFileAccess(actor, traversal)).toThrow(
        expect.objectContaining({ code: 'INVALID_STORAGE_KEY' }),
      );
    }
    expect(() => resolveFileAccess(manager(otherId, tenantA), '/absolute')).toThrow(
      DomainValidationException,
    );
  });
});
