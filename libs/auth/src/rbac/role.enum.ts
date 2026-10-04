/**
 * Coarse-grained roles carried in the access token. Authorization decisions should prefer
 * permissions (`@RequirePermissions`) — roles only group them (see `ROLE_PERMISSIONS`).
 * String values are persisted (Postgres `user_role` enum) and sent over gRPC: never rename them.
 */
export enum Role {
  Admin = 'admin',
  Moderator = 'moderator',
  User = 'user',
}

export const ROLE_VALUES: readonly Role[] = Object.freeze(Object.values(Role));

const ROLE_SET: ReadonlySet<string> = new Set(ROLE_VALUES);

/** Narrows untrusted input (token claims, gRPC metadata, DB rows). */
export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && ROLE_SET.has(value);
