import type { DatabaseMigrationSet } from '../database.types.js';
import { platformMigrations } from '../platform/platform.migrations.js';
import { readOnlineSteps } from './migration-files.js';
import { ONLINE_MIGRATIONS_TABLE } from './migrations.constants.js';

/** The platform set itself, not a set that only shares its name. */
const isPlatformSet = (set: DatabaseMigrationSet): boolean =>
  set.name === platformMigrations.name &&
  set.folder === platformMigrations.folder &&
  set.migrationsSchema === platformMigrations.migrationsSchema &&
  set.migrationsTable === platformMigrations.migrationsTable;

/**
 * What every migration run requires of its sets, checked without touching a database: the platform
 * set comes first (the domain sets call its helpers and rely on its grants), no set is listed twice,
 * and no two sets share a bookkeeping table: drizzle's migrator compares file timestamps only with
 * the newest row of the table it writes to, so the set with older timestamps would be skipped
 * silently. Nor do two sets with online steps share a schema (and so its `__online_migrations`).
 * A set with an `onlineFolder` is read (only such a set touches the file system): each step must
 * be a valid file anchored at a migration of the set's journal (`readOnlineSteps`).
 * `withPlatformMigrations` and `runMigrations` both call it.
 */
export function assertMigrationSets(sets: readonly DatabaseMigrationSet[]): void {
  const [first] = sets;
  if (first === undefined || !isPlatformSet(first)) {
    throw new Error(
      `The platform migration set must run first (got ${
        first === undefined ? 'no set' : `"${first.name}" from ${first.folder}`
      }): pass withPlatformMigrations(sets)`,
    );
  }
  const names = new Set<string>();
  const tableOwners = new Map<string, string>();
  for (const set of sets) {
    if (names.has(set.name)) {
      throw new Error(
        `Migration set "${set.name}" is listed twice` +
          (set.name === platformMigrations.name
            ? ': the platform set always runs first, do not pass it'
            : ''),
      );
    }
    names.add(set.name);
    const table = `${set.migrationsSchema}.${set.migrationsTable}`;
    const owner = tableOwners.get(table);
    if (owner !== undefined) {
      throw new Error(
        `Migration sets "${owner}" and "${set.name}" share ${table}: give each set its own bookkeeping table`,
      );
    }
    tableOwners.set(table, set.name);
  }
  const onlineOwners = new Map<string, string>();
  for (const set of sets) {
    if (set.onlineFolder === undefined) continue;
    const owner = onlineOwners.get(set.migrationsSchema);
    if (owner !== undefined) {
      throw new Error(
        `Migration sets "${owner}" and "${set.name}" both have online steps in schema ${set.migrationsSchema}: ` +
          `they would share ${set.migrationsSchema}.${ONLINE_MIGRATIONS_TABLE}; give one of them its own schema`,
      );
    }
    onlineOwners.set(set.migrationsSchema, set.name);
  }
  for (const set of sets) readOnlineSteps(set);
}

/**
 * The sets one process applies, in order: `platformMigrations` first (it cannot be left out or
 * reordered), then `sets` in array order. Rejects what `assertMigrationSets` rejects (a set listed
 * twice, two sets sharing one bookkeeping table, an online step anchored beyond its journal), here
 * at module definition.
 */
export function withPlatformMigrations(
  sets: readonly DatabaseMigrationSet[],
): readonly DatabaseMigrationSet[] {
  const ordered = [platformMigrations, ...sets];
  assertMigrationSets(ordered);
  return ordered;
}
