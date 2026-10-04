import { DomainValidationException, generateId, isUuid, toSafeFilename } from '@app/common';
import { assertStorageKey, buildStorageKey, isKeyWithinPrefix } from '@app/storage';
import { includes, isEmpty, last } from 'lodash-es';
import { USER_FILES_ROOT } from '../files.constants.js';

const UUID_LENGTH = 36;

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

/** `users/{userId}` — the "directory" a user owns (no trailing slash). */
export function userFilesPrefix(userId: string): string {
  return buildStorageKey(USER_FILES_ROOT, assertUserSegment(userId));
}

/**
 * `users/{userId}/{uuidv7}-{safeFilename}`: the uuidv7 makes every upload a new, time-ordered,
 * unguessable object (no overwrites, no enumeration), and `toSafeFilename` keeps the tail readable
 * and safe for keys, URLs and `Content-Disposition`.
 */
export function buildUserFileKey(
  userId: string,
  filename: string,
  id: string = generateId(),
): string {
  return buildStorageKey(userFilesPrefix(userId), `${id}-${toSafeFilename(filename)}`);
}

/**
 * Prefix ownership. Only meaningful for keys that passed `assertStorageKey` (no `..` segments),
 * which `isKeyWithinPrefix` cannot see through on its own; it does tell `users/u1` from `users/u10`.
 */
export function isFileKeyOwnedBy(key: string, userId: string): boolean {
  return isKeyWithinPrefix(key, userFilesPrefix(userId));
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

/**
 * The human part of a key built by `buildUserFileKey` (`{uuidv7}-report.pdf` → `report.pdf`), used as
 * the download filename. Keys of another shape yield their last segment.
 */
export function filenameOfFileKey(key: string): string {
  const segment = last(key.split('/')) ?? key;
  const hasIdPrefix =
    segment.length > UUID_LENGTH + 1 &&
    segment.charAt(UUID_LENGTH) === '-' &&
    isUuid(segment.slice(0, UUID_LENGTH));
  return hasIdPrefix ? segment.slice(UUID_LENGTH + 1) : segment;
}
