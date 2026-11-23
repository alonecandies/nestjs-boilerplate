import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'generated']);
/** The Idempotency-Key character class: `@platform/common` owns it (ARCH-7). */
const KEY_CHARSET = 'A-Za-z0-9._:-';
const OWNER = 'libs/common/src/constants/idempotency-key.constants.ts';

const posixPath = (path: string): string => relative(ROOT, path).split(sep).join('/');

function* tsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* tsFiles(path);
    else if (path.endsWith('.ts')) yield path;
  }
}

const hitsIn = (dir: string): string[] =>
  [...tsFiles(join(ROOT, dir))].flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        line.includes(KEY_CHARSET) ? [`${posixPath(file)}:${index + 1}: ${line.trim()}`] : [],
      ),
  );

describe('one Idempotency-Key contract (ARCH-7)', () => {
  it('@platform/common defines the key pattern', () => {
    expect(readFileSync(join(ROOT, OWNER), 'utf8')).toContain(KEY_CHARSET);
  });

  it('no domain keeps a second copy of the key pattern, specs and docs comments included', () => {
    expect(hitsIn('domains')).toEqual([]);
  });
});
