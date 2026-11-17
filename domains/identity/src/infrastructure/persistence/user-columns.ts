import { getTableColumns, ilike, or, type SQL } from 'drizzle-orm';
import { users } from './identity.schema.js';

/** Public projection: selecting it can never ship the password hash by accident. */
const { passwordHash: _passwordHash, ...columns } = getTableColumns(users);
export const publicUserColumns = columns;

/** `%`, `_` and `\` are wildcards/escape in ILIKE patterns: match them literally. */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/** Case-insensitive literal substring of email or display name; no filter for `undefined`. */
export function userSearchFilter(search: string | undefined): SQL | undefined {
  if (search === undefined) return undefined;
  const pattern = `%${escapeLike(search)}%`;
  return or(ilike(users.email, pattern), ilike(users.displayName, pattern));
}
