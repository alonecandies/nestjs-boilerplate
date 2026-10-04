import { isObjectLike } from 'lodash-es';

const UNIQUE_VIOLATION = '23505';
const MAX_CAUSE_DEPTH = 5;

/**
 * `true` when `error` (or one of its causes — drizzle 0.45 wraps driver errors in
 * `DrizzleQueryError`) is a Postgres unique violation, optionally on a specific constraint.
 * postgres.js exposes the SQLSTATE as `code` and the constraint as `constraint_name`.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isObjectLike(current); depth += 1) {
    const code: unknown = Reflect.get(current as object, 'code');
    if (code === UNIQUE_VIOLATION) {
      return (
        constraint === undefined || Reflect.get(current as object, 'constraint_name') === constraint
      );
    }
    current = Reflect.get(current as object, 'cause');
  }
  return false;
}
