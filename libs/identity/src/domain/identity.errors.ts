import {
  BusinessRuleViolationException,
  DomainConflictException,
  DomainValidationException,
  UnauthenticatedException,
  type ValidationIssue,
} from '@app/common';
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

/** 422 — an admin tried to drop their own admin role (would lock the last admin out). */
export class CannotRevokeOwnAdminRoleException extends BusinessRuleViolationException {
  constructor() {
    super('You cannot remove your own admin role', {
      code: IdentityErrorCode.CANNOT_REVOKE_OWN_ADMIN,
    });
  }
}

/** 422 — the change would remove the admin role from the last remaining admin. */
export class CannotRemoveLastAdminException extends BusinessRuleViolationException {
  constructor() {
    super('At least one admin must remain', {
      code: IdentityErrorCode.CANNOT_REMOVE_LAST_ADMIN,
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
