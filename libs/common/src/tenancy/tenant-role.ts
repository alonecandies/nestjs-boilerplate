/**
 * Roles a user holds in ONE tenant (spec §6): owner ⊇ admin ⊇ member. Stored in
 * `identity.memberships.roles`, carried by access tokens (`roles` = the roles in `tid`) and by the
 * request principal. The values are persisted and sent over gRPC: never rename them.
 */
export const TENANT_ROLES = ['owner', 'admin', 'member'] as const;

export type TenantRole = (typeof TENANT_ROLES)[number];

const TENANT_ROLE_SET: ReadonlySet<string> = new Set(TENANT_ROLES);

const IMPLIED: Readonly<Record<TenantRole, readonly TenantRole[]>> = Object.freeze({
  owner: Object.freeze(['owner', 'admin', 'member'] as const),
  admin: Object.freeze(['admin', 'member'] as const),
  member: Object.freeze(['member'] as const),
});

/** Narrows untrusted input (token claims, gRPC metadata, database rows). */
export function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === 'string' && TENANT_ROLE_SET.has(value);
}

/** The roles `role` implies, itself first. */
export function impliedTenantRoles(role: TenantRole): readonly TenantRole[] {
  return IMPLIED[role];
}

/** True when any of `held` implies `required`. */
export function satisfiesTenantRole(held: readonly TenantRole[], required: TenantRole): boolean {
  return held.some((role) => isTenantRole(role) && IMPLIED[role].includes(required));
}

/** Unknown values dropped, duplicates removed, canonical order (owner, admin, member). */
export function normalizeTenantRoles(values: readonly unknown[]): TenantRole[] {
  const present = new Set(values.filter(isTenantRole));
  return TENANT_ROLES.filter((role) => present.has(role));
}
