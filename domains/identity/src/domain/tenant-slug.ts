import { IDENTITY_LIMITS } from '../identity.constants.js';

/** DNS-label shape: lower-case alphanumerics and inner dashes, 1-63 characters. */
export const TENANT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const SLUG_BASE_MAX_LENGTH = 40;
const FALLBACK_SLUG = 'workspace';
const POSSESSIVE = "'s workspace";

/** NFKD, accents stripped, lower case, every run of other characters → '-', ≤ 40 chars; '' → 'workspace'. */
export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_BASE_MAX_LENGTH)
    .replace(/-+$/, '');
  return slug === '' ? FALLBACK_SLUG : slug;
}

/**
 * `<slugify(base)>-<last 8 hex digits of tenantId>` (≤ 49 chars). The suffix is random in a uuidv7, so two
 * tenants with the same base (`ada@a.io`, `ada@b.io`) get different slugs; `tenants_slug_unique` still
 * decides (409 `TENANT_SLUG_TAKEN` on the astronomically rare collision).
 */
export function deriveTenantSlug(base: string, tenantId: string): string {
  return `${slugify(base)}-${tenantId.replace(/-/g, '').slice(-8).toLowerCase()}`;
}

/** `<displayName>'s workspace`, cut by code points to `IDENTITY_LIMITS.TENANT_NAME_MAX_LENGTH`. */
export function personalWorkspaceName(displayName: string): string {
  const room = IDENTITY_LIMITS.TENANT_NAME_MAX_LENGTH - POSSESSIVE.length;
  return `${Array.from(displayName.trim()).slice(0, room).join('')}${POSSESSIVE}`;
}
