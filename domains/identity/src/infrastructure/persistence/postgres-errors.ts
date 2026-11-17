import { isObjectLike } from 'lodash-es';

const UNIQUE_VIOLATION = '23505';
const MAX_CAUSE_DEPTH = 5;
/** The constraint Postgres names in a violation message: `... constraint "<name>"`. */
const MESSAGE_CONSTRAINT = /constraint "([^"]+)"/;
/** Citus names a shard's constraint `<logical>_<shard id>`. */
const SHARD_SUFFIX = /^_\d+$/;

/** `name` is `constraint` itself or `constraint` followed by a Citus shard suffix. */
function namesConstraint(name: string, constraint: string): boolean {
  return (
    name === constraint ||
    (name.startsWith(constraint) && SHARD_SUFFIX.test(name.slice(constraint.length)))
  );
}

/** The constraint a 23505 error names: `constraint_name` when present, else the message's. */
function violatedConstraint(error: object): string | undefined {
  const name: unknown = Reflect.get(error, 'constraint_name');
  if (typeof name === 'string') return name;
  const message: unknown = Reflect.get(error, 'message');
  return typeof message === 'string' ? MESSAGE_CONSTRAINT.exec(message)?.[1] : undefined;
}

/**
 * `true` when `error` (or one of its causes — drizzle 0.45 wraps driver errors in
 * `DrizzleQueryError`) is a Postgres unique violation, optionally on a specific constraint.
 * postgres.js exposes the SQLSTATE as `code` and the constraint as `constraint_name`.
 *
 * On Citus the violation is raised by a shard, whose constraint is `<logical>_<shard id>`. With
 * local execution on, `constraint_name` carries that suffixed name; with it off (a real cluster)
 * the error is relayed from a worker without `constraint_name` and only the message names it.
 * Both shapes match the logical name; a different constraint sharing its prefix does not.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isObjectLike(current); depth += 1) {
    const code: unknown = Reflect.get(current as object, 'code');
    if (code === UNIQUE_VIOLATION) {
      if (constraint === undefined) return true;
      const name = violatedConstraint(current as object);
      return name !== undefined && namesConstraint(name, constraint);
    }
    current = Reflect.get(current as object, 'cause');
  }
  return false;
}
