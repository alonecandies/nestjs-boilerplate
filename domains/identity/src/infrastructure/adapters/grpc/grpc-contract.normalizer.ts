import type { AuthTokens, StaffAccessToken, User, UserPage } from '@domain/identity-contracts';
import { isEmpty } from 'lodash-es';

/**
 * What proto-loader (`defaults: true`, `oneofs: true`) really hands us: absent message fields
 * decode as `null` (not `undefined`) and proto3 `optional` scalars may be missing. The generated
 * interfaces don't say so — normalise at the adapter boundary so the remote adapter returns
 * exactly the shapes the local adapter returns.
 */
type Wire<T> = { [K in keyof T]?: T[K] | null };

export function normalizeUser(user: Wire<User>): User {
  return {
    id: user.id ?? '',
    email: user.email ?? '',
    displayName: user.displayName ?? '',
    roles: user.roles ?? [],
    createdAt: user.createdAt ?? undefined,
    updatedAt: user.updatedAt ?? undefined,
  };
}

export function normalizeAuthTokens(tokens: Wire<AuthTokens>): AuthTokens {
  return {
    accessToken: tokens.accessToken ?? '',
    refreshToken: tokens.refreshToken ?? '',
    expiresIn: tokens.expiresIn ?? 0,
    tokenType: tokens.tokenType ?? '',
    user: tokens.user ? normalizeUser(tokens.user) : undefined,
    tenantId: tokens.tenantId ?? '',
    tenantRoles: tokens.tenantRoles ?? [],
  };
}

/** proto-loader leaves absent scalars undefined on the client side: fill the contract defaults. */
export function normalizeStaffAccessToken(token: Partial<StaffAccessToken>): StaffAccessToken {
  return {
    accessToken: token.accessToken ?? '',
    expiresIn: token.expiresIn ?? 0,
    tokenType: token.tokenType ?? 'Bearer',
    tenantId: token.tenantId ?? '',
    auditEventId: token.auditEventId ?? '',
  };
}

export function normalizeUserPage(page: Wire<UserPage>): UserPage {
  const items = (page.items ?? []).map(normalizeUser);
  // Absent on the last page (never `null` / empty string).
  return isEmpty(page.nextCursor) || page.nextCursor == null
    ? { items }
    : { items, nextCursor: page.nextCursor };
}
