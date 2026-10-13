import type { DatabaseMigrationSet } from '../database.types.js';
import { platformMigrations } from '../platform/platform.migrations.js';

/**
 * The sets one process applies, in order: `platformMigrations` first (it cannot be left out or
 * reordered), then `sets` in array order. Rejects a set listed twice and two sets sharing one
 * bookkeeping table: drizzle's migrator compares file timestamps only with the newest row of the
 * table it writes to, so the set with older timestamps would be skipped silently.
 */
export function withPlatformMigrations(
  sets: readonly DatabaseMigrationSet[],
): readonly DatabaseMigrationSet[] {
  const ordered = [platformMigrations, ...sets];
  const names = new Set<string>();
  const tableOwners = new Map<string, string>();
  for (const set of ordered) {
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
  return ordered;
}
