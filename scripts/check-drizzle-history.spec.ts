import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const DRIZZLE_KIT = join(ROOT, 'node_modules', '.bin', 'drizzle-kit');
/** The Postgres domains: every domains/<x> with a drizzle.config.ts. */
const POSTGRES_DOMAINS = readdirSync(join(ROOT, 'domains'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(ROOT, 'domains', name, 'drizzle.config.ts')))
  .sort();
const historyOf = (domain: string): string =>
  join(ROOT, 'domains', domain, 'src', 'infrastructure', 'persistence', 'migrations');

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}
interface Journal {
  entries: JournalEntry[];
}
interface Snapshot {
  id: string;
  prevId: string;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Copies a domain's history to `<tmp>/m`; returns `<tmp>`. */
function copyHistory(domain: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'drizzle-history-'));
  dirs.push(dir);
  cpSync(historyOf(domain), join(dir, 'm'), { recursive: true });
  return dir;
}

/** drizzle-kit prefixes --out with `./`: run it from the parent with a relative folder. */
function drizzleCheck(cwd: string): { status: number | null; output: string } {
  const result = spawnSync(DRIZZLE_KIT, ['check', '--dialect', 'postgresql', '--out', 'm'], {
    cwd,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

describe('bun run db:check', () => {
  it('covers the identity and billing histories', () => {
    expect(POSTGRES_DOMAINS).toEqual(expect.arrayContaining(['billing', 'identity']));
  });

  it('runs drizzle-kit check in every Postgres domain and passes on the committed histories', () => {
    const result = spawnSync('bun', ['run', 'db:check'], { cwd: ROOT, encoding: 'utf8' });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output.match(/Everything's fine/g)?.length).toBe(POSTGRES_DOMAINS.length);
  }, 60_000);

  it.each(POSTGRES_DOMAINS)('accepts a copy of the committed %s history', (domain) => {
    const result = drizzleCheck(copyHistory(domain));
    expect(result.status, result.output).toBe(0);
  });

  it('rejects a history forked by two lanes (two snapshots with the same parent)', () => {
    const dir = copyHistory('billing');
    const meta = join(dir, 'm', 'meta');
    const journal = readJson<Journal>(join(meta, '_journal.json'));
    const last = journal.entries.at(-1);
    if (last === undefined) throw new Error('billing has no migrations');
    const parent = readJson<Snapshot & Record<string, unknown>>(
      join(meta, `${String(last.idx).padStart(4, '0')}_snapshot.json`),
    );
    for (const [offset, lane] of ['a', 'b'].entries()) {
      const idx = last.idx + 1 + offset;
      const prefix = String(idx).padStart(4, '0');
      const id = `0000000${offset + 1}-0000-4000-8000-000000000000`;
      writeFileSync(
        join(meta, `${prefix}_snapshot.json`),
        JSON.stringify({ ...parent, id, prevId: parent.id }),
      );
      writeFileSync(join(dir, 'm', `${prefix}_lane_${lane}.sql`), 'SELECT 1;\n');
      journal.entries.push({
        ...last,
        idx,
        when: last.when + 1 + offset,
        tag: `${prefix}_lane_${lane}`,
      });
    }
    writeFileSync(join(meta, '_journal.json'), JSON.stringify(journal));

    const result = drizzleCheck(dir);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('collision');
  });
});
