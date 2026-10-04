/** Why a lock was not acquired: another holder has it, or Redis could not be reached. */
export type LockSkipReason = 'held' | 'error';

/** Outcome of `DistributedLockService.using()`. */
export type LockResult<T> =
  | { readonly acquired: true; readonly result: T }
  | { readonly acquired: false; readonly reason: LockSkipReason };

/**
 * Minimum lock TTL. Redlock requires `ttl - 100ms >= automaticExtensionThreshold`; below this the
 * auto-extension window is too small to be reliable.
 */
export const MIN_LOCK_TTL_MS = 200;
