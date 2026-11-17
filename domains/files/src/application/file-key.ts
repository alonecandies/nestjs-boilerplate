import {
  DomainValidationException,
  generateId,
  isPlatformTenantId,
  isUuid,
  toSafeFilename,
} from '@platform/common';
import { assertStorageKey, buildStorageKey, isKeyWithinPrefix } from '@platform/storage';
import { includes, isEmpty, last } from 'lodash-es';
import { TENANT_FILES_ROOT, USER_FILES_ROOT } from '../files.constants.js';

/**
 * The tenant becomes ONE key segment: a UUID (lower-cased, so one tenant has one prefix) and never
 * the platform tenant. It must come from the principal (`AuthUser.tenantId`), never from a request.
 */
function assertTenantSegment(tenantId: string): string {
  if (!isUuid(tenantId) || isPlatformTenantId(tenantId)) {
    throw new DomainValidationException('Invalid tenant id for a file key', {
      issues: [{ path: 'tenantId', message: 'must be a UUID other than the platform tenant' }],
    });
  }
  return tenantId.toLowerCase();
}

/**
 * A user id becomes ONE key segment. An id containing `/` would silently nest one user's prefix
 * inside another's (`users/a` would then own `users/a/b/...`), so it is rejected outright.
 */
function assertUserSegment(userId: string): string {
  if (isEmpty(userId) || includes(userId, '/')) {
    throw new DomainValidationException('Invalid user id for a file key', {
      issues: [{ path: 'userId', message: 'must be a single, non-empty key segment' }],
    });
  }
  return userId;
}

/** `tenants/{tenantId}` — every object of a tenant lies strictly under it (no trailing slash). */
export function tenantFilesPrefix(tenantId: string): string {
  return buildStorageKey(TENANT_FILES_ROOT, assertTenantSegment(tenantId));
}

/** `tenants/{tenantId}/users/{userId}` — the "directory" a user owns in a tenant (no trailing slash). */
export function userFilesPrefix(tenantId: string, userId: string): string {
  return buildStorageKey(tenantFilesPrefix(tenantId), USER_FILES_ROOT, assertUserSegment(userId));
}

/**
 * `tenants/{tenantId}/users/{userId}/{uuidv7}/{safeFilename}`, the only builder of object keys: the
 * uuidv7 makes every upload a new, time-ordered, unguessable object (no overwrites, no enumeration),
 * and `toSafeFilename` keeps the last segment readable and safe for keys, URLs and
 * `Content-Disposition`.
 */
export function buildUserFileKey(
  tenantId: string,
  userId: string,
  filename: string,
  id: string = generateId(),
): string {
  return buildStorageKey(userFilesPrefix(tenantId, userId), id, toSafeFilename(filename));
}

/**
 * Prefix ownership in a tenant. Only meaningful for keys that passed `assertStorageKey` (no `..`
 * segments), which `isKeyWithinPrefix` cannot see through on its own; it does tell `users/u1` from
 * `users/u10`.
 */
export function isFileKeyOwnedBy(key: string, tenantId: string, userId: string): boolean {
  return isKeyWithinPrefix(key, userFilesPrefix(tenantId, userId));
}

/** `true` for keys the storage layer would accept (for request validation). */
export function isValidFileKey(key: string): boolean {
  try {
    assertStorageKey(key);
    return true;
  } catch {
    return false;
  }
}

/** The download filename: the last key segment (the `safeFilename` of `buildUserFileKey`). */
export function filenameOfFileKey(key: string): string {
  return last(key.split('/')) ?? key;
}
