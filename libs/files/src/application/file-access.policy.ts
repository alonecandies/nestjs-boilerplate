import { hasPermissions, Permission } from '@app/auth';
import { assertStorageKey } from '@app/storage';
import { isFileKeyOwnedBy } from './file-key.js';
import type { FileAccess, FileActor } from './files.types.js';

/**
 * Ownership by key prefix (`users/{actor.id}/…`); `files:manage` (admins) bypasses it.
 * The key is validated FIRST: a prefix test alone would let `users/me/../you/x` through.
 *
 * @throws DomainValidationException `INVALID_STORAGE_KEY` (422) for malformed keys
 */
export function resolveFileAccess(actor: FileActor, key: string): FileAccess {
  assertStorageKey(key);
  if (isFileKeyOwnedBy(key, actor.id)) return 'owner';
  return hasPermissions(actor.permissions, [Permission.FilesManage]) ? 'manager' : 'denied';
}
