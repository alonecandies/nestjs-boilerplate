// End-of-run summary helpers for script.js (handleSummary). Plain JS with no k6 imports, so the
// specs in scripts/perf can load it under Node.
//
// k6 reports a submetric in the handleSummary data only when a threshold names it, so every
// (scenario, endpoint) series gets an always-true `max>=0` threshold; its p95 is then read back
// under the same key. The JSON summary feeds scripts/perf/k6-baseline.mjs and compare-k6.mjs.

export const SUMMARY_FORMAT = 'k6-p95-summary/1';
const COLLECT_CONDITION = 'max>=0';

/** The threshold key (and handleSummary metric name) of one series. */
export function seriesThresholdKey(scenario, endpoint) {
  for (const value of [scenario, endpoint]) {
    // k6's threshold selector splits on ',' and ':'.
    if (/[,:]/.test(value))
      throw new Error(`a series tag value cannot contain ',' or ':': ${value}`);
  }
  return `http_req_duration{phase:load,scenario:${scenario},name:${endpoint}}`;
}

/** series: { scenario: endpoint[] } -> the collection thresholds for options.thresholds. */
export function seriesThresholds(series) {
  const thresholds = {};
  for (const [scenario, endpoints] of Object.entries(series)) {
    for (const endpoint of endpoints)
      thresholds[seriesThresholdKey(scenario, endpoint)] = [COLLECT_CONDITION];
  }
  return thresholds;
}

const isCollection = (name, metric) =>
  name.startsWith('http_req_duration{phase:load,scenario:') &&
  Object.keys(metric.thresholds ?? {}).every((condition) => condition === COLLECT_CONDITION);

/**
 * The JSON summary of one run: the p95 (and median, p99, sample count) of each series that has
 * samples, keyed by scenario and endpoint tag. A series without samples is left out, so a
 * comparison reports it as missing instead of trusting a p95 of 0.
 * meta: { runId, settings, series: { scenario: endpoint[] } }
 */
export function buildP95Summary(data, meta) {
  const scenarios = {};
  for (const [scenario, endpoints] of Object.entries(meta.series)) {
    for (const endpoint of endpoints) {
      const values = data.metrics[seriesThresholdKey(scenario, endpoint)]?.values;
      const count = values?.count ?? 0;
      const p95 = values?.['p(95)'];
      if (!(count > 0) || !(p95 > 0)) continue;
      scenarios[scenario] ??= {};
      scenarios[scenario][endpoint] = { p95, med: values.med, p99: values['p(99)'], count };
    }
  }
  const thresholdsOk = Object.values(data.metrics).every((metric) =>
    Object.values(metric.thresholds ?? {}).every((threshold) => threshold.ok),
  );
  return {
    format: SUMMARY_FORMAT,
    runId: meta.runId,
    settings: meta.settings,
    iterations: data.metrics.iterations?.values.count ?? 0,
    droppedIterations: data.metrics.dropped_iterations?.values.count ?? 0,
    thresholdsOk,
    scenarios,
  };
}

const ms = (value) => `${Number(value).toFixed(2)}ms`;

function formatMetric(metric, trendStats) {
  const { values } = metric;
  switch (metric.type) {
    case 'trend':
      return trendStats
        .filter((stat) => stat !== 'count' && values[stat] !== undefined)
        .map((stat) => `${stat}=${metric.contains === 'time' ? ms(values[stat]) : values[stat]}`)
        .join(' ');
    case 'counter':
      return `${values.count}  ${Number(values.rate).toFixed(2)}/s`;
    case 'rate':
      return `${(values.rate * 100).toFixed(2)}%  ${values.passes} of ${values.passes + values.fails}`;
    default:
      return Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
  }
}

/**
 * The end-of-run text (k6 prints nothing of its own once handleSummary exists): the thresholds,
 * the p95 per scenario and endpoint, then every metric that is not a series submetric.
 */
export function renderTextSummary(data, series) {
  const metrics = Object.entries(data.metrics).sort(([a], [b]) => a.localeCompare(b));
  const trendStats = data.options?.summaryTrendStats ?? [
    'avg',
    'min',
    'med',
    'max',
    'p(90)',
    'p(95)',
  ];
  const lines = ['', 'THRESHOLDS'];
  for (const [name, metric] of metrics) {
    if (isCollection(name, metric)) continue;
    for (const [condition, { ok }] of Object.entries(metric.thresholds ?? {})) {
      lines.push(`  ${ok ? '✓' : '✗'} ${name}  ${condition}`);
    }
  }

  lines.push('', 'P95 PER SCENARIO AND ENDPOINT (phase:load)');
  const rows = Object.entries(series).flatMap(([scenario, endpoints]) =>
    endpoints.map((endpoint) => {
      const values = data.metrics[seriesThresholdKey(scenario, endpoint)]?.values ?? {};
      return [
        scenario,
        endpoint,
        ms(values['p(95)'] ?? 0).replace('ms', ' ms'),
        String(values.count ?? 0),
      ];
    }),
  );
  const widths = [0, 1, 2].map((column) => Math.max(...rows.map((row) => row[column].length)));
  for (const [scenario, endpoint, p95, count] of rows) {
    lines.push(
      `  ${scenario.padEnd(widths[0])}  ${endpoint.padEnd(widths[1])}  ${p95.padStart(widths[2])}  ${count}`,
    );
  }

  lines.push('', 'METRICS');
  const shown = metrics.filter(([name, metric]) => !isCollection(name, metric));
  const nameWidth = Math.max(...shown.map(([name]) => name.length));
  for (const [name, metric] of shown) {
    lines.push(`  ${name.padEnd(nameWidth)}  ${formatMetric(metric, trendStats)}`);
  }
  return `${lines.join('\n')}\n`;
}
