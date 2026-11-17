import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, 'k6-baseline.mjs');
const COMPARE = join(import.meta.dirname, 'compare-k6.mjs');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'k6-baseline-'));
  dirs.push(dir);
  return dir;
}

/** One run summary as docker/k6/summary.js writes it; p95s: scenario -> endpoint -> p95. */
function run(
  runId: string,
  p95s: Record<string, Record<string, number>>,
  droppedIterations = 0,
): Record<string, unknown> {
  const scenarios = Object.fromEntries(
    Object.entries(p95s).map(([scenario, endpoints]) => [
      scenario,
      Object.fromEntries(
        Object.entries(endpoints).map(([e, p95]) => [
          e,
          { p95, med: p95 / 2, p99: p95 * 2, count: 100 },
        ]),
      ),
    ]),
  );
  return {
    format: 'k6-p95-summary/1',
    runId,
    settings: { rate: 5, readRate: 20, duration: '3m', p95Ms: 250 },
    iterations: 4500,
    droppedIterations,
    thresholdsOk: true,
    scenarios,
  };
}

function merge(args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Writes each run to <dir>/<name>.json; returns name -> path. */
function writeRuns<K extends string>(dir: string, runs: Record<K, unknown>): Record<K, string> {
  const paths = {} as Record<K, string>;
  for (const name of Object.keys(runs) as K[]) {
    const content = runs[name];
    const path = join(dir, `${name}.json`);
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
    paths[name] = path;
  }
  return paths;
}

describe('scripts/perf/k6-baseline.mjs', () => {
  it('writes three runs per topology and the median p95 of each series', () => {
    const dir = tempDir();
    const paths = writeRuns(dir, {
      m1: run('m1', { journey: { 'GET /v1/auth/me': 30 }, browse: { 'GET /v1/auth/me': 9 } }),
      m2: run('m2', { journey: { 'GET /v1/auth/me': 10 }, browse: { 'GET /v1/auth/me': 11 } }),
      m3: run('m3', { journey: { 'GET /v1/auth/me': 20 }, browse: { 'GET /v1/auth/me': 10 } }),
      s1: run('s1', { journey: { 'GET /v1/auth/me': 40 } }),
      s2: run('s2', { journey: { 'GET /v1/auth/me': 44 } }),
      s3: run('s3', { journey: { 'GET /v1/auth/me': 42 } }),
    });
    const out = join(dir, 'baseline.json');
    const result = merge([
      '--commit',
      '0dcfd18',
      '--out',
      out,
      ...(['m1', 'm2', 'm3'] as const).map((n) => `--run=monolith=${paths[n]}`),
      ...(['s1', 's2', 's3'] as const).flatMap((n) => ['--run', `microservices=${paths[n]}`]),
    ]);
    expect(result.status, result.output).toBe(0);
    const baseline = JSON.parse(readFileSync(out, 'utf8')) as {
      format: string;
      commit: string;
      topologies: Record<string, { runs: { runId: string }[]; median: unknown }>;
    };
    expect(baseline.format).toBe('k6-p95-baseline/1');
    expect(baseline.commit).toBe('0dcfd18');
    expect(baseline.topologies.monolith?.runs.map((r) => r.runId)).toEqual(['m1', 'm2', 'm3']);
    expect(baseline.topologies.monolith?.median).toEqual({
      journey: { 'GET /v1/auth/me': { p95: 20 } },
      browse: { 'GET /v1/auth/me': { p95: 10 } },
    });
    expect(baseline.topologies.microservices?.median).toEqual({
      journey: { 'GET /v1/auth/me': { p95: 42 } },
    });

    // The file it writes is what compare-k6.mjs reads.
    const self = spawnSync(process.execPath, [COMPARE, out, out], { encoding: 'utf8' });
    expect(self.status, `${self.stdout}${self.stderr}`).toBe(0);
  });

  it('takes the mean of the two middle runs for an even count', () => {
    const dir = tempDir();
    const paths = writeRuns(dir, {
      a: run('a', { journey: { 'GET /v1/auth/me': 10 } }),
      b: run('b', { journey: { 'GET /v1/auth/me': 13 } }),
    });
    const result = merge([
      '--commit',
      'abc',
      `--run=monolith=${paths.a}`,
      `--run=monolith=${paths.b}`,
    ]);
    expect(result.status, result.output).toBe(0);
    const baseline = JSON.parse(result.output) as {
      topologies: Record<string, { median: Record<string, Record<string, { p95: number }>> }>;
    };
    expect(baseline.topologies.monolith?.median.journey?.['GET /v1/auth/me']?.p95).toBe(11.5);
  });

  it('exits 2 naming a run with dropped iterations', () => {
    const dir = tempDir();
    const paths = writeRuns(dir, {
      ok: run('ok', { journey: { 'GET /v1/auth/me': 10 } }),
      dropped: run('dropped', { journey: { 'GET /v1/auth/me': 10 } }, 3),
    });
    const result = merge([
      '--commit',
      'abc',
      `--run=monolith=${paths.ok}`,
      `--run=monolith=${paths.dropped}`,
    ]);
    expect(result.status, result.output).toBe(2);
    expect(result.output).toContain(`${paths.dropped}: 3 dropped iterations`);
  });

  it('exits 2 naming a series that one run of a topology lacks', () => {
    const dir = tempDir();
    const paths = writeRuns(dir, {
      full: run('full', { journey: { 'GET /v1/auth/me': 10, 'POST /graphql me': 20 } }),
      partial: run('partial', { journey: { 'GET /v1/auth/me': 10 } }),
    });
    const result = merge([
      '--commit',
      'abc',
      `--run=monolith=${paths.full}`,
      `--run=monolith=${paths.partial}`,
    ]);
    expect(result.status, result.output).toBe(2);
    expect(result.output).toContain(`${paths.partial}: missing monolith/journey: POST /graphql me`);
  });

  it('exits 2 naming a run file that is not a k6 summary', () => {
    const dir = tempDir();
    const paths = writeRuns(dir, { broken: '{"format":', other: { hello: 'world' } });
    const broken = merge(['--commit', 'abc', `--run=monolith=${paths.broken}`]);
    expect(broken.status).toBe(2);
    expect(broken.output).toContain(`${paths.broken}: not valid JSON`);
    const other = merge(['--commit', 'abc', `--run=monolith=${paths.other}`]);
    expect(other.status).toBe(2);
    expect(other.output).toContain(`${paths.other}: not a k6 p95 summary`);
  });

  it('exits 2 with usage without a commit, a run, or a topology name', () => {
    for (const args of [
      [],
      ['--commit', 'abc'],
      ['--commit', 'abc', '--run', 'no-topology.json'],
    ]) {
      const result = merge(args);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.output).toContain('usage: node scripts/perf/k6-baseline.mjs');
    }
  });
});
