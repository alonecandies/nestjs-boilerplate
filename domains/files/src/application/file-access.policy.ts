import { hasPermissions } from '@platform/auth';
import { assertStorageKey, isKeyWithinPrefix } from '@platform/storage';
import { FilesPermission } from '../files.permissions.js';
import { isFileKeyOwnedBy, tenantFilesPrefix } from './file-key.js';
import type { FileAccess, FileActor } from './files.types.js';

/**
 * How `actor` may reach `key`, in this order:
 * 1. the key is validated (a prefix test alone would let `tenants/<A>/../<B>/…` through);
 * 2. outside `tenants/{actor.tenantId}/` → `denied`, whatever the permissions: every other tenant's
 *    key and every legacy `users/…` key;
 * 3. under `tenants/{actor.tenantId}/users/{actor.id}/` → `owner`;
 * 4. `files:manage` (any file of the active tenant) → `manager`; the caller logs it;
 * 5. otherwise `denied`.
 *
 * @throws DomainValidationException `INVALID_STORAGE_KEY` (422) for malformed keys
 */
export function resolveFileAccess(actor: FileActor, key: string): FileAccess {
  assertStorageKey(key);
  if (!isKeyWithinPrefix(key, tenantFilesPrefix(actor.tenantId))) return 'denied';
  if (isFileKeyOwnedBy(key, actor.tenantId, actor.id)) return 'owner';
  return hasPermissions(actor.permissions, [FilesPermission.Manage]) ? 'manager' : 'denied';
}
