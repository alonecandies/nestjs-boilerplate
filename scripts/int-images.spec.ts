import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * CI-2 (audit 2026-11-23): the integration job pre-pulls the images its specs start, from the
 * image constants of the testing packages, so a new int image cannot be missed by the job.
 */
const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(import.meta.dirname, 'int-images.mjs');
const CI = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

function run(...args: string[]): { status: number | null; stdout: string; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout,
    output: `${result.stdout}${result.stderr}`,
  };
}

const images = (): string[] => run().stdout.split('\n').filter(Boolean);
const named = (): Map<string, string> =>
  new Map(
    run('--names')
      .stdout.split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name = '', image = ''] = line.split('=');
        return [name, image];
      }),
  );

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Every non-test source of the repo that starts a container: `new XContainer(<arg>`. */
function containerStarts(): { file: string; arg: string }[] {
  const found: { file: string; arg: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'coverage', 'generated'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        const text = readFileSync(path, 'utf8');
        for (const match of text.matchAll(/new \w*Container\(\s*([\w'`:./${}-]+)/g)) {
          found.push({ file: path.slice(ROOT.length + 1), arg: match[1] ?? '' });
        }
      }
    }
  };
  for (const dir of ['apps', 'domains', 'libs']) walk(join(ROOT, dir));
  return found;
}

describe('scripts/int-images.mjs', () => {
  it('prints the image of every kind of container the int specs start', () => {
    const list = images();
    expect(list).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^citusdata\/citus:\d/),
        expect.stringMatching(/^cassandra:\d/),
        expect.stringMatching(/^apache\/kafka:\d/),
        expect.stringMatching(/^codenotary\/immudb:\d/),
        expect.stringMatching(/^rustfs\/rustfs:\d/),
        expect.stringMatching(/^fsouza\/fake-gcs-server:\d/),
      ]),
    );
    expect(new Set(list).size).toBe(list.length);
    for (const image of list) expect(image).toMatch(/^[\w./-]+:[\w.-]+$/);
  });

  it('prints the Ryuk reaper image the installed testcontainers starts first in every fork', () => {
    // Read here independently of the script: the default of testcontainers' reaper.
    const reaper = readFileSync(
      join(ROOT, 'node_modules', 'testcontainers', 'build', 'reaper', 'reaper.js'),
      'utf8',
    );
    const ryuk = /ImageName\.fromString\("(testcontainers\/ryuk:[\w.-]+)"\)/.exec(reaper)?.[1];
    expect(ryuk).toMatch(/^testcontainers\/ryuk:\d/);
    expect(images()).toContain(ryuk);
    expect(named().get('RYUK_IMAGE')).toBe(ryuk);
  });

  it('names every container image a spec or helper starts, so a new one cannot be missed', () => {
    const list = images();
    const names = named();
    const starts = containerStarts();
    expect(starts.length).toBeGreaterThan(5);
    for (const { file, arg } of starts) {
      if (/^['`]/.test(arg)) {
        expect(list, `${file} starts ${arg}`).toContain(arg.slice(1, -1));
      } else {
        expect([...names.keys()], `${file} starts a container from ${arg}`).toContain(arg);
      }
    }
  });

  it('is what the integration job pre-pulls, not a single hard-coded image', () => {
    expect(CI).toContain('node scripts/int-images.mjs');
    expect(CI).not.toContain('docker pull citusdata/citus');
  });

  it('fails, naming the constant, when an image constant is gone', () => {
    const root = mkdtempSync(join(tmpdir(), 'int-images-'));
    roots.push(root);
    const file = 'libs/testing/src/postgres/start-test-postgres.ts';
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), '// the constant moved\n');
    const result = run('--root', root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('TEST_POSTGRES_IMAGE');
  });
});
