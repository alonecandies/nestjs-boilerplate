// Compares the k6 p95 of every series (topology / scenario / endpoint) of two baseline files, as
// scripts/perf/k6-baseline.mjs writes them (the median of each topology's runs):
//   node scripts/perf/compare-k6.mjs <baseline.json> <candidate.json> [--max-p95-regression 0.10]
// Exit 0: every candidate p95 is at most (1 + bound) x the baseline p95 (a faster one always passes).
// Exit 1: lists each series over the bound.
// Exit 2: a series (or topology) missing from either file, an unreadable or malformed file, or bad
//         arguments; this wins over exit 1, since an incomplete comparison proves nothing.
// The RLS gate (docs/PERFORMANCE.md, "RLS gate") runs it on docker/k6/baselines/*.json.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const USAGE =
  'usage: node scripts/perf/compare-k6.mjs <baseline.json> <candidate.json> [--max-p95-regression 0.10]';
const BASELINE_FORMAT = 'k6-p95-baseline/1';
// Absorbs floating point noise: (41.03 - 37.3) / 37.3 is 0.10000000000000012, not 0.1.
const EPSILON = 1e-9;

/** Exit 2 with every message, one per line. */
function abort(messages) {
  for (const message of messages) console.error(`compare-k6: ${message}`);
  process.exit(2);
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: { 'max-p95-regression': { type: 'string', default: '0.10' } },
    });
  } catch (error) {
    abort([error.message, USAGE]);
  }
  const { positionals, values } = parsed;
  if (positionals.length !== 2) abort([USAGE]);
  const raw = values['max-p95-regression'];
  const bound = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(bound) || bound < 0) {
    abort([`--max-p95-regression must be a number >= 0 (a ratio: 0.10 is 10%), got "${raw}"`]);
  }
  return { baselinePath: positionals[0], candidatePath: positionals[1], bound };
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const seriesName = (topology, scenario, endpoint) => `${topology}/${scenario}: ${endpoint}`;

/** Map of series name -> median p95 (ms), plus the problems found while reading `path`. */
function readSeries(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { problems: [`${path}: cannot be read (${error.code ?? error.message})`] };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { problems: [`${path}: not valid JSON (${error.message})`] };
  }
  if (!isObject(json) || json.format !== BASELINE_FORMAT || !isObject(json.topologies)) {
    return {
      problems: [
        `${path}: not a k6 p95 baseline (expected "format": "${BASELINE_FORMAT}" and a "topologies" object)`,
      ],
    };
  }
  const series = new Map();
  const problems = [];
  for (const [topology, entry] of Object.entries(json.topologies)) {
    if (!isObject(entry) || !isObject(entry.median)) {
      problems.push(`${path}: topology ${topology} has no "median" object`);
      continue;
    }
    for (const [scenario, endpoints] of Object.entries(entry.median)) {
      if (!isObject(endpoints)) {
        problems.push(`${path}: ${topology}/${scenario} is not an object of endpoints`);
        continue;
      }
      for (const [endpoint, value] of Object.entries(endpoints)) {
        const name = seriesName(topology, scenario, endpoint);
        const p95 = isObject(value) ? value.p95 : undefined;
        if (typeof p95 !== 'number' || !Number.isFinite(p95) || p95 <= 0) {
          problems.push(`${path}: ${name} has no positive p95 (got ${JSON.stringify(p95)})`);
          continue;
        }
        series.set(name, p95);
      }
    }
  }
  if (series.size === 0 && problems.length === 0) problems.push(`${path}: holds no series`);
  return { series, problems };
}

const percent = (ratio) => `${ratio >= 0 ? '+' : ''}${(ratio * 100).toFixed(1)}%`;

function main() {
  const { baselinePath, candidatePath, bound } = parseCli();
  const baseline = readSeries(baselinePath);
  const candidate = readSeries(candidatePath);
  const problems = [...baseline.problems, ...candidate.problems];
  if (problems.length > 0) abort(problems);

  for (const name of baseline.series.keys()) {
    if (!candidate.series.has(name)) problems.push(`missing from the candidate: ${name}`);
  }
  for (const name of candidate.series.keys()) {
    if (!baseline.series.has(name)) problems.push(`missing from the baseline: ${name}`);
  }
  if (problems.length > 0) abort(problems);

  const rows = [...baseline.series].map(([name, before]) => {
    const after = candidate.series.get(name);
    const ratio = (after - before) / before;
    return { name, before, after, ratio, over: ratio > bound + EPSILON };
  });
  const width = Math.max(...rows.map((row) => row.name.length));
  for (const row of rows) {
    console.log(
      `${row.over ? 'OVER' : 'ok  '}  ${row.name.padEnd(width)}  ${row.before.toFixed(2)} ms -> ${row.after.toFixed(2)} ms  ${percent(row.ratio)}`,
    );
  }
  const over = rows.filter((row) => row.over);
  if (over.length > 0) {
    console.error(`\n${over.length} series over the ${percent(bound)} p95 bound:`);
    for (const row of over) console.error(`  ${row.name}: ${percent(row.ratio)}`);
    process.exit(1);
  }
  console.log(`\n${rows.length} series within the ${percent(bound)} p95 bound.`);
}

main();
