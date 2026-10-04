import { deburr, kebabCase, repeat, truncate } from 'lodash-es';

/** Canonical form used for uniqueness checks and lookups (`users.email` stores this form). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * `john.doe@example.com` → `j******e@example.com`. For logs and notifications where the address
 * must be recognisable to its owner but not harvestable.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  const local = at > 0 ? email.slice(0, at) : email;
  const domain = at > 0 ? email.slice(at) : '';
  if (local.length <= 2)
    return `${local.charAt(0)}${repeat('*', Math.max(1, local.length - 1))}${domain}`;
  return `${local.charAt(0)}${repeat('*', local.length - 2)}${local.charAt(local.length - 1)}${domain}`;
}

const MAX_EXTENSION_LENGTH = 16;

/**
 * Makes a user-supplied filename safe for object keys and `Content-Disposition`: strips any path,
 * transliterates accents (deburr), kebab-cases the base name to `[a-z0-9-]`, keeps a sanitized
 * lower-case extension and caps the total length (default 120). Falls back to `file`.
 */
export function toSafeFilename(name: string, maxLength = 120): string {
  const basename = name.split(/[/\\]/).pop() ?? '';
  const dot = basename.lastIndexOf('.');
  // A leading dot (".env") is part of the name, not an extension separator.
  const rawBase = dot > 0 ? basename.slice(0, dot) : basename;
  const rawExt = dot > 0 ? basename.slice(dot + 1) : '';

  const ext = deburr(rawExt)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '')
    .slice(0, MAX_EXTENSION_LENGTH);
  const suffix = ext ? `.${ext}` : '';
  const base = kebabCase(deburr(rawBase)).replaceAll(/[^a-z0-9-]/g, '') || 'file';
  const room = Math.max(1, maxLength - suffix.length);
  const trimmedBase = truncate(base, { length: room, omission: '' }).replace(/-+$/, '') || 'file';
  return `${trimmedBase}${suffix}`;
}
