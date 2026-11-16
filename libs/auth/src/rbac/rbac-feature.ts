import { isTenantRole, type TenantRole } from '@platform/common';

/** `<resource>:<action>`, lower-case kebab segments: `orders:read`, `members:manage`. */
export const PERMISSION_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

export function isPermissionName(value: unknown): value is string {
  return typeof value === 'string' && PERMISSION_PATTERN.test(value);
}

/**
 * One domain's RBAC vocabulary (spec §6): the permissions it owns and the tenant roles that get each
 * by default. Grants are cumulative through owner ⊇ admin ⊇ member. Registered at boot with
 * `RbacModule.forFeature(feature)`; no platform file names a domain permission.
 */
export interface RbacFeature {
  /** The owner of the vocabulary (a domain's name); used in error messages. */
  readonly name: string;
  readonly permissions: readonly string[];
  readonly grants: Readonly<Partial<Record<TenantRole, readonly string[]>>>;
}

/** Every problem of `feature`, empty when it is valid. */
export function rbacFeatureProblems(feature: RbacFeature): string[] {
  const problems: string[] = [];
  if (feature.name.trim() === '') problems.push('name is empty');
  const declared = new Set<string>();
  for (const permission of feature.permissions) {
    const quoted = `"${permission}"`;
    if (!isPermissionName(permission)) problems.push(`malformed permission ${quoted}`);
    else if (declared.has(permission)) problems.push(`duplicate permission ${quoted}`);
    declared.add(permission);
  }
  for (const [role, granted] of Object.entries(feature.grants)) {
    if (!isTenantRole(role)) problems.push(`unknown role "${role}"`);
    for (const permission of granted ?? []) {
      if (!declared.has(permission)) {
        problems.push(`grant of undeclared permission "${permission}" to ${role}`);
      }
    }
  }
  return problems;
}

/** Validates and freezes a feature (throws `Error` listing every problem). */
export function defineRbacFeature<const TPermission extends string>(feature: {
  name: string;
  permissions: readonly TPermission[];
  grants: Partial<Record<TenantRole, readonly NoInfer<TPermission>[]>>;
}): RbacFeature {
  const problems = rbacFeatureProblems(feature);
  if (problems.length > 0) {
    throw new Error(`Invalid RBAC feature "${feature.name}": ${problems.join('; ')}`);
  }
  const grants: Partial<Record<TenantRole, readonly string[]>> = {};
  for (const [role, granted] of Object.entries(feature.grants)) {
    if (isTenantRole(role)) grants[role] = Object.freeze([...new Set(granted ?? [])].sort());
  }
  return Object.freeze({
    name: feature.name,
    permissions: Object.freeze([...feature.permissions].sort()),
    grants: Object.freeze(grants),
  });
}
