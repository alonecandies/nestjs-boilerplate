import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { DatabaseMigrationSet } from '../database.types.js';

/**
 * What drizzle's migrator reads from each journal entry: `tag` names the `.sql` file, `when` becomes
 * the bookkeeping row's `created_at`, `breakpoints` how the file is split. drizzle applies only the
 * files whose `when` is newer than the last applied row, so `when` must be a positive integer that
 * grows within the set: an entry without one (or an older one) would be skipped silently.
 */
const journalSchema = z.object({
  entries: z
    .array(z.object({ tag: z.string(), when: z.int().positive(), breakpoints: z.boolean() }))
    .superRefine((entries, ctx) => {
      for (const [index, entry] of entries.entries()) {
        const previous = entries[index - 1];
        if (previous !== undefined && entry.when <= previous.when) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'when'],
            message: `must be greater than the previous entry's (${previous.when}): drizzle skips a file that is not newer than the last applied one`,
          });
        }
      }
    }),
});

export type MigrationJournal = z.infer<typeof journalSchema>;

/** Where a set's drizzle journal lives. */
export const journalPath = (folder: string): string => join(folder, 'meta', '_journal.json');

/** The set's parsed drizzle journal; a missing or invalid journal fails the run. */
export function readJournal(set: DatabaseMigrationSet): MigrationJournal {
  const path = journalPath(set.folder);
  if (!existsSync(path)) {
    throw new Error(
      `Migration set "${set.name}" has no drizzle journal (${path}): generate its first migration, or leave the set out`,
    );
  }
  const journal = journalSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!journal.success) {
    throw new Error(
      `Invalid drizzle migration journal: ${path}\n${z.prettifyError(journal.error)}`,
    );
  }
  return journal.data;
}

/** A Postgres identifier as written: double-quoted (kept exactly) or bare (folded to lower case). */
const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;

/** Any `CREATE [UNIQUE] INDEX CONCURRENTLY`, named or not. */
const ANY_INDEX_CONCURRENTLY = /^\s*create\s+(?:unique\s+)?index\s+concurrently\b/i;

/**
 * `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS <index> ON [ONLY] <table>`: the only form an
 * online step may take (`readOnlineSteps`).
 */
export const CREATE_INDEX_CONCURRENTLY = new RegExp(
  String.raw`^\s*create\s+(?:unique\s+)?index\s+concurrently\s+if\s+not\s+exists\s+` +
    String.raw`(${IDENTIFIER})\s+on\s+(?:only\s+)?(${IDENTIFIER}(?:\.${IDENTIFIER})?)`,
  'i',
);

/** One file of a set's `onlineFolder`: a single statement, run outside a transaction. */
export interface OnlineStep {
  /** The file name, also its bookkeeping key (`__online_migrations.name`). */
  name: string;
  path: string;
  statement: string;
  /**
   * The journal index of the transactional migration the step follows (the file's `NNNN`, also that
   * migration's number): it runs once the set's files up to that one are applied, before the next.
   */
  anchor: number;
}

/**
 * `NNNN_<name>.sql`: `NNNN` is the anchor, the 4-digit index of the transactional migration the
 * step follows (the number drizzle-kit gives that file, which its journal entry's tag must carry);
 * steps sharing an anchor run in name order.
 */
const ONLINE_STEP_FILE = /^(\d{4})_[\w-]+\.sql$/;

/** SQL text without its comments: enough to see whether a file holds a statement, and which. */
export const withoutComments = (text: string): string =>
  text.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/--[^\n]*/g, ' ');

/**
 * The set's online steps in file order (anchor order), read without connecting: a declared folder
 * that is missing (or a set without a journal), a file that is not `NNNN_<name>.sql`, a file with no
 * statement, one anchored beyond the set's journal or at an entry whose tag does not start with its
 * `NNNN` (a hand-edited journal) fails up front. One statement per file is enforced by the server
 * (the file is sent on the extended protocol, which refuses several commands).
 * `assertMigrationSets` and `runMigrations` call it for every set with an `onlineFolder`.
 */
export function readOnlineSteps(set: DatabaseMigrationSet): OnlineStep[] {
  const folder = set.onlineFolder;
  if (folder === undefined) return [];
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new Error(
      `Migration set "${set.name}" declares online steps in ${folder}, which does not exist`,
    );
  }
  const { entries } = readJournal(set);
  return readdirSync(folder)
    .toSorted()
    .map((name) => {
      const number = ONLINE_STEP_FILE.exec(name)?.[1];
      if (number === undefined) {
        throw new Error(
          `Migration set "${set.name}": online folder ${folder} holds "${name}"; only NNNN_<name>.sql files, one statement each, belong there`,
        );
      }
      const anchor = Number(number);
      const path = join(folder, name);
      const statement = readFileSync(path, 'utf8');
      const code = withoutComments(statement);
      if (code.replaceAll(';', ' ').trim() === '') {
        throw new Error(
          `Migration set "${set.name}": online step ${name} (${path}) holds no statement`,
        );
      }
      if (ANY_INDEX_CONCURRENTLY.test(code) && !CREATE_INDEX_CONCURRENTLY.test(code)) {
        throw new Error(
          `Migration set "${set.name}": online step ${name} (${path}) must name its index and say ` +
            'IF NOT EXISTS (CREATE INDEX CONCURRENTLY IF NOT EXISTS <name> ON <table> …): the ' +
            'runner finds an invalid index left by a failed build by that name, and a rerun must ' +
            'skip a built one',
        );
      }
      if (anchor >= entries.length) {
        throw new Error(
          `Migration set "${set.name}": online step ${name} (${path}) is anchored at ${number}, ` +
            `beyond the set's journal (${entries.length} file(s), the last is ` +
            `${entries.at(-1)?.tag ?? 'none'}): NNNN is the index of the migration it follows`,
        );
      }
      // A journal edited by hand (an entry removed, two swapped) moves the file at index NNNN; the
      // step must still follow the migration it was written with, so the entry must carry NNNN.
      const tag = entries[anchor]?.tag ?? '';
      const tagNumber = /^(\d+)_/.exec(tag)?.[1];
      if (tagNumber === undefined || Number(tagNumber) !== anchor) {
        throw new Error(
          `Migration set "${set.name}": online step ${name} (${path}) is anchored at ${number}, ` +
            `but the journal's entry ${number} is ${tag}: NNNN is the number of the migration ` +
            'the step follows, and the journal must list that migration at that index',
        );
      }
      return { name, path, statement, anchor };
    });
}
