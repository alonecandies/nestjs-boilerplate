/** Canonical form used for uniqueness checks and lookups (`users.email` stores this form). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
