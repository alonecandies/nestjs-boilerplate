import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/** docker/k6/summary.js runs inside k6 (plain JS, no k6 imports), so it is loaded untyped. */
interface SummaryModule {
  SUMMARY_FORMAT: string;
  seriesThresholdKey(scenario: string, endpoint: string): string;
  seriesThresholds(series: Record<string, readonly string[]>): Record<string, string[]>;
  buildP95Summary(data: unknown, meta: Record<string, unknown>): P95Summary;
  renderTextSummary(data: unknown, series: Record<string, readonly string[]>): string;
}
interface P95Summary {
  format: string;
  runId: string;
  settings: Record<string, unknown>;
  iterations: number;
  droppedIterations: number;
  thresholdsOk: boolean;
  scenarios: Record<
    string,
    Record<string, { p95: number; med: number; p99: number; count: number }>
  >;
}

const MODULE = join(import.meta.dirname, '..', '..', 'docker', 'k6', 'summary.js');
let summary: SummaryModule;

beforeAll(async () => {
  summary = (await import(pathToFileURL(MODULE).href)) as SummaryModule;
});

const trend = (p95: number, count: number, ok?: boolean) => ({
  type: 'trend',
  contains: 'time',
  values: {
    avg: p95 / 2,
    min: 1,
    med: p95 / 2,
    'p(90)': p95 - 1,
    'p(95)': p95,
    'p(99)': p95 + 1,
    max: p95 + 2,
    count,
  },
  ...(ok === undefined ? {} : { thresholds: { 'max>=0': { ok } } }),
});

const SERIES = {
  journey: ['POST /v1/auth/register', 'GET /v1/auth/me'],
  browse: ['GET /v1/auth/me'],
} as const;

/** The data k6 2.3 hands to handleSummary (shape probed on grafana/k6:2.3.0). */
function k6Data(overrides: Record<string, unknown> = {}): unknown {
  return {
    options: {
      summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
    },
    state: { testRunDurationMs: 60_000 },
    metrics: {
      http_req_duration: trend(180, 900),
      'http_req_duration{phase:load}': {
        ...trend(170, 850),
        thresholds: { 'p(95)<250': { ok: true } },
      },
      'http_req_duration{phase:load,scenario:journey,name:POST /v1/auth/register}': trend(
        210.5,
        300,
        true,
      ),
      'http_req_duration{phase:load,scenario:journey,name:GET /v1/auth/me}': trend(
        12.25,
        300,
        true,
      ),
      'http_req_duration{phase:load,scenario:browse,name:GET /v1/auth/me}': trend(9.5, 1200, true),
      iterations: { type: 'counter', contains: 'default', values: { count: 1500, rate: 25 } },
      http_req_failed: {
        type: 'rate',
        contains: 'default',
        values: { rate: 0, passes: 0, fails: 900 },
      },
      ...overrides,
    },
  };
}

const META = {
  runId: 'mono1',
  settings: { rate: 5, readRate: 20, duration: '3m', p95Ms: 250 },
  series: SERIES,
};

describe('docker/k6/summary.js', () => {
  it('builds the threshold key k6 exposes a submetric under', () => {
    expect(summary.seriesThresholdKey('journey', 'GET /v1/users/<id>')).toBe(
      'http_req_duration{phase:load,scenario:journey,name:GET /v1/users/<id>}',
    );
    expect(summary.seriesThresholds(SERIES)).toEqual({
      'http_req_duration{phase:load,scenario:journey,name:POST /v1/auth/register}': ['max>=0'],
      'http_req_duration{phase:load,scenario:journey,name:GET /v1/auth/me}': ['max>=0'],
      'http_req_duration{phase:load,scenario:browse,name:GET /v1/auth/me}': ['max>=0'],
    });
  });

  it('refuses a tag value k6 cannot parse in a threshold selector', () => {
    expect(() => summary.seriesThresholdKey('journey', 'GET /a,b')).toThrow(/cannot contain/);
    expect(() => summary.seriesThresholdKey('jour:ney', 'GET /a')).toThrow(/cannot contain/);
  });

  it('keys the p95 of each series by scenario and endpoint tag', () => {
    const result = summary.buildP95Summary(k6Data(), META);
    expect(result).toEqual({
      format: 'k6-p95-summary/1',
      runId: 'mono1',
      settings: META.settings,
      iterations: 1500,
      droppedIterations: 0,
      thresholdsOk: true,
      scenarios: {
        journey: {
          'POST /v1/auth/register': { p95: 210.5, med: 105.25, p99: 211.5, count: 300 },
          'GET /v1/auth/me': { p95: 12.25, med: 6.125, p99: 13.25, count: 300 },
        },
        browse: { 'GET /v1/auth/me': { p95: 9.5, med: 4.75, p99: 10.5, count: 1200 } },
      },
    });
    expect(summary.SUMMARY_FORMAT).toBe(result.format);
  });

  it('records dropped iterations and failed thresholds', () => {
    const result = summary.buildP95Summary(
      k6Data({
        dropped_iterations: {
          type: 'counter',
          contains: 'default',
          values: { count: 4, rate: 0.1 },
        },
        'http_req_duration{phase:load}': {
          ...trend(300, 850),
          thresholds: { 'p(95)<250': { ok: false } },
        },
      }),
      META,
    );
    expect(result.droppedIterations).toBe(4);
    expect(result.thresholdsOk).toBe(false);
  });

  it('leaves out a series with no samples, so a comparison reports it as missing', () => {
    const result = summary.buildP95Summary(
      k6Data({
        'http_req_duration{phase:load,scenario:browse,name:GET /v1/auth/me}': trend(0, 0, true),
      }),
      META,
    );
    expect(result.scenarios).not.toHaveProperty('browse');
    expect(Object.keys(result.scenarios.journey ?? {})).toEqual([
      'POST /v1/auth/register',
      'GET /v1/auth/me',
    ]);
  });

  it('leaves out a series k6 did not report at all', () => {
    const data = k6Data() as { metrics: Record<string, unknown> };
    delete data.metrics['http_req_duration{phase:load,scenario:journey,name:GET /v1/auth/me}'];
    const result = summary.buildP95Summary(data, META);
    expect(Object.keys(result.scenarios.journey ?? {})).toEqual(['POST /v1/auth/register']);
  });

  it('renders the end-of-run text: thresholds, the p95 per series, then the metrics', () => {
    const text = summary.renderTextSummary(
      k6Data({
        'http_req_failed{phase:load}': {
          type: 'rate',
          contains: 'default',
          values: { rate: 0.02, passes: 18, fails: 882 },
          thresholds: { 'rate<0.01': { ok: false } },
        },
      }),
      SERIES,
    );
    expect(text).toContain('THRESHOLDS');
    expect(text).toMatch(/✓ http_req_duration\{phase:load\}\s+p\(95\)<250/);
    expect(text).toMatch(/✗ http_req_failed\{phase:load\}\s+rate<0\.01/);
    // The collection thresholds (max>=0) are not listed as thresholds; the p95 table shows them.
    expect(text).not.toContain('max>=0');
    expect(text).toContain('P95 PER SCENARIO AND ENDPOINT');
    expect(text).toMatch(/journey\s+POST \/v1\/auth\/register\s+210\.50 ms\s+300/);
    expect(text).toMatch(/browse\s+GET \/v1\/auth\/me\s+9\.50 ms\s+1200/);
    expect(text).toMatch(
      /http_req_duration\s+avg=90\.00ms min=1\.00ms med=90\.00ms p\(90\)=179\.00ms/,
    );
    expect(text).toMatch(/iterations\s+1500\s+25\.00\/s/);
    expect(text).toMatch(/http_req_failed\s+0\.00%/);
    expect(text.endsWith('\n')).toBe(true);
  });
});
