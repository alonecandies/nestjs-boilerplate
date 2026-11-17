import { isPlatformTenantId, isUuid } from '@platform/common';
import { REDIS_KEY_SEPARATOR, type RedisKeyPart } from '../keys/key.util.js';

/** Lower-case kebab words: the scope names the feature that owns the entries. */
const SCOPE = /^[a-z][a-z0-9-]*$/;

/**
 * The one builder of cache keys for tenant-scoped data: `<scope>:<tenantId>:<part>…`
 * (`AppCacheService` adds `${REDIS_KEY_PREFIX}:cache:`). The tenant sits right after the scope, so
 * two tenants never share a key for equal parts, and a tenant's entries share one prefix.
 *
 * Pass the tenant of the principal (`AuthUser.tenantId` / `requirePrincipal().tenantId`) or of a
 * validated event envelope, never one from a request body. The tenant id must be a UUID and is
 * lower-cased; the platform tenant (nil UUID) is refused, because platform rows are not served
 * from a tenant's cache. At least one part is required; parts must be non-empty, contain no `:`
 * and, when numbers, be finite.
 *
 * @throws TypeError for a malformed scope, tenant id or part.
 */
export function tenantCacheKey(
  scope: string,
  tenantId: string,
  ...parts: readonly RedisKeyPart[]
): string {
  if (!SCOPE.test(scope)) {
    throw new TypeError(`Cache scope must match ${SCOPE.source}`);
  }
  if (!isUuid(tenantId) || isPlatformTenantId(tenantId)) {
    throw new TypeError('Cache tenant id must be a tenant UUID (not the platform tenant)');
  }
  if (parts.length === 0) throw new TypeError('A tenant cache key needs at least one part');
  let key = `${scope}${REDIS_KEY_SEPARATOR}${tenantId.toLowerCase()}`;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] as RedisKeyPart;
    const text = String(part);
    const invalid =
      typeof part === 'number'
        ? !Number.isFinite(part)
        : text.length === 0 || text.includes(REDIS_KEY_SEPARATOR);
    if (invalid) {
      throw new TypeError(
        `Tenant cache key part #${index} must be a non-empty string without ':' or a finite number`,
      );
    }
    key += REDIS_KEY_SEPARATOR + text;
  }
  return key;
}
