import type { AuthUser } from '../types/auth-user.js';

/**
 * Users a trusted early hook (the GraphQL operation rate limiter, which runs before the global
 * guards and verifies the bearer token to key its budget) has verified for ONE request object.
 * `JwtAuthGuard` reuses the entry for a GraphQL request instead of verifying the same token and
 * reading the denylist a second time. Keyed by the request, so another request never sees it, and
 * only code that runs the same checks as `JwtStrategy` may write it.
 */
const verifiedUsers = new WeakMap<object, AuthUser>();

/** Records that `user` was verified from `req`'s own bearer token (signature, claims, denylist). */
export function rememberVerifiedUser(req: object, user: AuthUser): void {
  verifiedUsers.set(req, user);
}

/** The user an earlier hook verified for `req`, if any. */
export function takeVerifiedUser(req: object): AuthUser | undefined {
  return verifiedUsers.get(req);
}
