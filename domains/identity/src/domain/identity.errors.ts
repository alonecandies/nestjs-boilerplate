import {
  BusinessRuleViolationException,
  DomainConflictException,
  DomainValidationException,
  PermissionDeniedException,
  UnauthenticatedException,
  type ValidationIssue,
} from '@platform/common';
import { IdentityErrorCode } from '../identity.constants.js';

/*
 * Identity errors. Each one is a DomainException subclass with a stable `code`; transports map
 * them (REST problem+json, gRPC status + `x-error-code` trailer, GraphQL `extensions.code`).
 * Messages never contain the email or any token (they end up in logs and client responses).
 */

/** 409 — registration with an email that already has an account. */
export class EmailAlreadyTakenException extends DomainConflictException {
  constructor(options?: { cause?: unknown }) {
    super('An account with this email already exists', {
      code: IdentityErrorCode.EMAIL_TAKEN,
      cause: options?.cause,
    });
  }
}

/**
 * 401 — unknown email OR wrong password. Deliberately one error with one message (no user
 * enumeration); the handler also equalises timing with a dummy argon2 verification.
 */
export class InvalidCredentialsException extends UnauthenticatedException {
  constructor() {
    super('Invalid email or password', { code: IdentityErrorCode.INVALID_CREDENTIALS });
  }
}

/** 401 — the refresh token is malformed, forged, unknown or not bound to this user. */
export class InvalidRefreshTokenException extends UnauthenticatedException {
  constructor(options?: { cause?: unknown }) {
    super('Invalid refresh token', {
      code: IdentityErrorCode.INVALID_REFRESH_TOKEN,
      cause: options?.cause,
    });
  }
}

/** 401 — the refresh token (and its session) expired: the client must log in again. */
export class SessionExpiredException extends UnauthenticatedException {
  constructor(options?: { cause?: unknown }) {
    super('Session has expired, please log in again', {
      code: IdentityErrorCode.SESSION_EXPIRED,
      cause: options?.cause,
    });
  }
}

/**
 * 401 — a refresh token that was already rotated (or revoked) was presented again. Either the
 * legitimate client or an attacker holds a stolen copy, so every session of the user has been
 * revoked (theft detection, OAuth 2.0 Security BCP §4.14.2).
 */
export class RefreshTokenReuseDetectedException extends UnauthenticatedException {
  constructor() {
    super('Refresh token reuse detected; all sessions have been revoked', {
      code: IdentityErrorCode.REFRESH_TOKEN_REUSED,
    });
  }
}

/** 422 — role list empty or containing unknown role names. */
export class InvalidRolesException extends DomainValidationException {
  constructor(issues: readonly ValidationIssue[]) {
    super('Invalid roles', { code: IdentityErrorCode.INVALID_ROLES, issues });
  }
}

/** 422 — aggregate invariant violated (e.g. blank display name reaching the domain). */
export class InvalidUserException extends DomainValidationException {
  constructor(issues: readonly ValidationIssue[]) {
    super('Invalid user', { code: IdentityErrorCode.INVALID_USER, issues });
  }
}

/** 409 — a tenant with this slug already exists. */
export class TenantSlugTakenException extends DomainConflictException {
  constructor(options?: { cause?: unknown }) {
    super('A workspace with this slug already exists', {
      code: IdentityErrorCode.TENANT_SLUG_TAKEN,
      cause: options?.cause,
    });
  }
}

/** 409 — the user is already a member of this tenant. */
export class MembershipAlreadyExistsException extends DomainConflictException {
  constructor(options?: { cause?: unknown }) {
    super('The user is already a member of this workspace', {
      code: IdentityErrorCode.MEMBERSHIP_EXISTS,
      cause: options?.cause,
    });
  }
}

/**
 * 403 — login or switch to a tenant the user may not use. One error for "not a member", "unknown
 * tenant" and the platform tenant, so tenant ids cannot be probed.
 */
export class TenantAccessDeniedException extends PermissionDeniedException {
  constructor() {
    super('You are not a member of this workspace', {
      code: IdentityErrorCode.TENANT_ACCESS_DENIED,
    });
  }
}

/** 401 — the session's membership was removed: the session is revoked, the client logs in again. */
export class MembershipRevokedException extends UnauthenticatedException {
  constructor() {
    super('Your access to this workspace was removed; please log in again', {
      code: IdentityErrorCode.MEMBERSHIP_REVOKED,
    });
  }
}

/**
 * 422 (gRPC FAILED_PRECONDITION) — the retired global-role RPC `UpdateUserRoles`. Roles are per tenant
 * since B2 (memberships); platform staff is a flag set by the staff:grant CLI.
 */
export class GlobalRolesRemovedException extends BusinessRuleViolationException {
  constructor() {
    super('Global roles were removed: roles belong to tenant memberships', {
      code: IdentityErrorCode.GLOBAL_ROLES_REMOVED,
    });
  }
}

/** 403 — a staff switch-in token tried to switch tenant (switch out instead, then log in as yourself). */
export class StaffTokenNotAllowedException extends PermissionDeniedException {
  constructor() {
    super('A staff switch-in token cannot switch tenants', {
      code: IdentityErrorCode.STAFF_TOKEN_NOT_ALLOWED,
    });
  }
}

/** 403 — switch-in by a user whose `is_platform_staff` flag is not set (read fresh, never from the token). */
export class NotPlatformStaffException extends PermissionDeniedException {
  constructor() {
    super('Platform staff only', { code: IdentityErrorCode.STAFF_ONLY });
  }
}
