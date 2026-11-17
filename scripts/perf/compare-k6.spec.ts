import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, 'compare-k6.mjs');

/** topology -> scenario -> endpoint -> median p95 (ms). */
type P95s = Record<string, Record<string, Record<string, number>>>;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A baseline file as scripts/perf/k6-baseline.mjs writes it (runs left empty: compare reads medians). */
function baselineOf(p95s: P95s): unknown {
  const topologies = Object.fromEntries(
    Object.entries(p95s).map(([topology, scenarios]) => [
      topology,
      {
        runs: [],
        median: Object.fromEntries(
          Object.entries(scenarios).map(([scenario, endpoints]) => [
            scenario,
            Object.fromEntries(Object.entries(endpoints).map(([e, p95]) => [e, { p95 }])),
          ]),
        ),
      },
    ]),
  );
  return { format: 'k6-p95-baseline/1', commit: '0000000', topologies };
}

function compare(
  baseline: unknown,
  candidate: unknown,
  extraArgs: string[] = [],
): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'compare-k6-'));
  dirs.push(dir);
  const write = (name: string, content: unknown): string => {
    const path = join(dir, name);
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
    return path;
  };
  const result = spawnSync(
    process.execPath,
    [SCRIPT, write('baseline.json', baseline), write('candidate.json', candidate), ...extraArgs],
    { encoding: 'utf8' },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const BASE: P95s = {
  monolith: {
    journey: { 'POST /v1/auth/login': 100, 'GET /v1/auth/me': 37.3 },
    browse: { 'GET /v1/auth/me': 12 },
  },
  microservices: {
    journey: { 'POST /v1/auth/login': 120, 'GET /v1/auth/me': 45 },
    browse: { 'GET /v1/auth/me': 15 },
  },
};

/** BASE with one series' p95 replaced. */
function withP95(topology: string, scenario: string, endpoint: string, p95: number): P95s {
  const copy = structuredClone(BASE);
  const endpoints = copy[topology]?.[scenario];
  if (!endpoints) throw new Error(`no ${topology}/${scenario} in BASE`);
  endpoints[endpoint] = p95;
  return copy;
}

/** BASE without one series. */
function without(topology: string, scenario: string, endpoint: string): P95s {
  const copy = structuredClone(BASE);
  delete copy[topology]?.[scenario]?.[endpoint];
  return copy;
}

describe('scripts/perf/compare-k6.mjs', () => {
  it('passes equal files and prints every series', () => {
    const result = compare(baselineOf(BASE), baselineOf(BASE));
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('monolith/journey: POST /v1/auth/login');
    expect(result.output).toContain('microservices/browse: GET /v1/auth/me');
    expect(result.output).toContain('6 series within the +10.0% p95 bound');
  });

  it('passes a +10.0% regression, also on a baseline that is not a round number', () => {
    const round = compare(
      baselineOf(BASE),
      baselineOf(withP95('monolith', 'journey', 'POST /v1/auth/login', 110)),
    );
    expect(round.status, round.output).toBe(0);
    // (41.03 - 37.3) / 37.3 is 0.10000000000000012 in floating point: still within the bound.
    const fractional = compare(
      baselineOf(BASE),
      baselineOf(withP95('monolith', 'journey', 'GET /v1/auth/me', 41.03)),
    );
    expect(fractional.status, fractional.output).toBe(0);
  });

  it('fails a +10.1% regression and lists only the series over the bound', () => {
    const result = compare(
      baselineOf(BASE),
      baselineOf(withP95('monolith', 'journey', 'POST /v1/auth/login', 110.1)),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('1 series over the +10.0% p95 bound');
    expect(result.output).toMatch(
      /OVER\s+monolith\/journey: POST \/v1\/auth\/login\s+100\.00 ms -> 110\.10 ms\s+\+10\.1%/,
    );
    expect(result.output).not.toMatch(/OVER\s+microservices/);
  });

  it('fails +10.1% on a fractional baseline too (37.3 -> 41.07)', () => {
    const result = compare(
      baselineOf(BASE),
      baselineOf(withP95('monolith', 'journey', 'GET /v1/auth/me', 41.07)),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toMatch(/OVER\s+monolith\/journey: GET \/v1\/auth\/me/);
  });

  it('passes a faster candidate', () => {
    const result = compare(
      baselineOf(BASE),
      baselineOf(withP95('microservices', 'journey', 'POST /v1/auth/login', 60)),
    );
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/microservices\/journey: POST \/v1\/auth\/login.*-50\.0%/);
  });

  it('takes the bound from --max-p95-regression, in both spellings', () => {
    const slower = baselineOf(withP95('monolith', 'browse', 'GET /v1/auth/me', 13.8)); // +15%
    expect(compare(baselineOf(BASE), slower).status).toBe(1);
    const spaced = compare(baselineOf(BASE), slower, ['--max-p95-regression', '0.20']);
    expect(spaced.status, spaced.output).toBe(0);
    expect(spaced.output).toContain('within the +20.0% p95 bound');
    expect(compare(baselineOf(BASE), slower, ['--max-p95-regression=0.05']).status).toBe(1);
  });

  it('exits 2 naming a series missing from the candidate', () => {
    const result = compare(
      baselineOf(BASE),
      baselineOf(without('microservices', 'browse', 'GET /v1/auth/me')),
    );
    expect(result.status, result.output).toBe(2);
    expect(result.output).toContain(
      'missing from the candidate: microservices/browse: GET /v1/auth/me',
    );
  });

  it('exits 2 naming a series missing from the baseline', () => {
    const result = compare(
      baselineOf(without('monolith', 'journey', 'GET /v1/auth/me')),
      baselineOf(BASE),
    );
    expect(result.status, result.output).toBe(2);
    expect(result.output).toContain('missing from the baseline: monolith/journey: GET /v1/auth/me');
  });

  it('exits 2 naming a topology missing on one side', () => {
    const { microservices: _dropped, ...monolithOnly } = BASE;
    const result = compare(baselineOf(BASE), baselineOf(monolithOnly));
    expect(result.status, result.output).toBe(2);
    expect(result.output).toContain(
      'missing from the candidate: microservices/journey: POST /v1/auth/login',
    );
  });

  it('exits 2 (not 1) when a series is missing and another is over the bound', () => {
    const candidate = withP95('monolith', 'journey', 'POST /v1/auth/login', 200);
    delete candidate.monolith?.browse?.['GET /v1/auth/me'];
    const result = compare(baselineOf(BASE), baselineOf(candidate));
    expect(result.status, result.output).toBe(2);
    expect(result.output).toContain('missing from the candidate: monolith/browse: GET /v1/auth/me');
  });

  it('exits 2 naming a file that is not JSON', () => {
    const result = compare('{"format": "k6-p95-baseline/1", ', baselineOf(BASE));
    expect(result.status, result.output).toBe(2);
    expect(result.output).toMatch(/baseline\.json: not valid JSON/);
  });

  it('exits 2 naming a file that is JSON but not a baseline', () => {
    const result = compare(baselineOf(BASE), { metrics: {} });
    expect(result.status, result.output).toBe(2);
    expect(result.output).toMatch(/candidate\.json: not a k6 p95 baseline/);
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['a string', '12'],
    ['null', null],
  ])('exits 2 naming a series whose p95 is %s', (_label, p95) => {
    const candidate = baselineOf(BASE) as {
      topologies: Record<string, { median: Record<string, Record<string, { p95: unknown }>> }>;
    };
    const series = candidate.topologies.monolith?.median.browse?.['GET /v1/auth/me'];
    if (!series) throw new Error('fixture lost its series');
    series.p95 = p95;
    const result = compare(baselineOf(BASE), candidate);
    expect(result.status, result.output).toBe(2);
    expect(result.output).toMatch(
      /candidate\.json: monolith\/browse: GET \/v1\/auth\/me has no positive p95/,
    );
  });

  it('exits 2 with usage on a missing file argument or a bad bound', () => {
    const missing = spawnSync(process.execPath, [SCRIPT, 'only-one.json'], { encoding: 'utf8' });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('usage: node scripts/perf/compare-k6.mjs');
    const bad = compare(baselineOf(BASE), baselineOf(BASE), ['--max-p95-regression', 'ten']);
    expect(bad.status).toBe(2);
    expect(bad.output).toContain('--max-p95-regression must be a number >= 0');
  });

  it('exits 2 naming a file that does not exist', () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '/nonexistent/a.json', '/nonexistent/b.json'],
      {
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('/nonexistent/a.json: cannot be read');
  });
});
