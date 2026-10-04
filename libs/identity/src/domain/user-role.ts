import type { Role } from '@app/auth';

/*
 * Role names as the identity domain (and the `user_role` Postgres enum) knows them.
 *
 * This file is also loaded by drizzle-kit through `identity.schema.ts`, whose loader does not know
 * the workspace source condition: it must stay free of runtime imports. `import type` keeps it
 * checked against @app/auth's `Role` (the RBAC source of truth) at compile time only; a spec
 * asserts both lists are identical.
 */
export const USER_ROLES = ['admin', 'moderator', 'user'] as const satisfies readonly `${Role}`[];

export type UserRole = (typeof USER_ROLES)[number];

export const DEFAULT_USER_ROLE = 'user' satisfies UserRole;
export const ADMIN_ROLE = 'admin' satisfies UserRole;

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}
