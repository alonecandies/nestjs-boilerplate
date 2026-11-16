import {
  isTenantRole,
  normalizeTenantRoles,
  PermissionDeniedException,
  satisfiesTenantRole,
  type TenantRole,
} from '@platform/common';
import { InvalidRolesException, OwnerRankRequiredException } from './identity.errors.js';

/** Exact tenant roles: non-empty, known, no duplicates; canonical order. */
export function parseTenantRoles(values: readonly unknown[]): TenantRole[] {
  const unknown = values.filter((value) => !isTenantRole(value));
  if (values.length === 0 || unknown.length > 0 || new Set(values).size !== values.length) {
    throw new InvalidRolesException([
      { path: 'roles', message: 'One or more of owner, admin, member, without duplicates' },
    ]);
  }
  return normalizeTenantRoles(values);
}

const requireManager = (actor: readonly TenantRole[]): void => {
  if (!satisfiesTenantRole(actor, 'admin')) {
    throw new PermissionDeniedException('Managing members requires members:manage', {
      details: { required: ['members:manage'] },
    });
  }
};

/** members:manage (admin rank) to change roles; owner rank when `current` or `next` contains owner. */
export function assertCanAssignRoles(
  actor: readonly TenantRole[],
  current: readonly TenantRole[] | null,
  next: readonly TenantRole[],
): void {
  requireManager(actor);
  const touchesOwner = (current ?? []).includes('owner') || next.includes('owner');
  if (touchesOwner && !satisfiesTenantRole(actor, 'owner')) throw new OwnerRankRequiredException();
}

/** members:manage to remove; owner rank to remove an owner. */
export function assertCanRemove(actor: readonly TenantRole[], target: readonly TenantRole[]): void {
  requireManager(actor);
  if (target.includes('owner') && !satisfiesTenantRole(actor, 'owner'))
    throw new OwnerRankRequiredException();
}
