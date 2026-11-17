// Builds a k6 p95 baseline from the run summaries docker/k6/script.js writes (handleSummary, one
// docker/k6/reports/k6-summary-<RUN_ID>.json per run):
//   node scripts/perf/k6-baseline.mjs --commit <sha> [--out <file>] \
//     --run monolith=<run.json> ... --run microservices=<run.json> ...
// Per topology it keeps every run and the median p95 of each series (the mean of the two middle
// runs for an even count). Prints to stdout without --out. Exit 2, naming the file, on a run with
// dropped iterations (the arrival rate was not sustained, so its percentiles are not comparable),
// a series that one run of a topology lacks, or a file that is not a run summary.
// scripts/perf/compare-k6.mjs compares two of these files.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const USAGE =
  'usage: node scripts/perf/k6-baseline.mjs --commit <sha> [--out <file>] --run <topology>=<summary.json> [--run ...]';
const SUMMARY_FORMAT = 'k6-p95-summary/1';
const BASELINE_FORMAT = 'k6-p95-baseline/1';

function abort(messages) {
  for (const message of messages) console.error(`k6-baseline: ${message}`);
  process.exit(2);
}

function parseCli() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        commit: { type: 'string' },
        out: { type: 'string' },
        run: { type: 'string', multiple: true },
      },
    }));
  } catch (error) {
    abort([error.message, USAGE]);
  }
  if (!values.commit || !values.run?.length) abort([USAGE]);
  const runs = values.run.map((spec) => {
    const at = spec.indexOf('=');
    if (at <= 0 || at === spec.length - 1)
      abort([`--run "${spec}" is not <topology>=<file>`, USAGE]);
    return { topology: spec.slice(0, at), path: spec.slice(at + 1) };
  });
  return { commit: values.commit, out: values.out, runs };
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The run summary at `path`, or a problem naming it. */
function readRun(path) {
  let json;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'not valid JSON' : 'cannot be read';
    return { problem: `${path}: ${reason} (${error.code ?? error.message})` };
  }
  if (!isObject(json) || json.format !== SUMMARY_FORMAT || !isObject(json.scenarios)) {
    return { problem: `${path}: not a k6 p95 summary (expected "format": "${SUMMARY_FORMAT}")` };
  }
  if (json.droppedIterations !== 0) {
    return {
      problem: `${path}: ${json.droppedIterations} dropped iterations (a baseline needs 0)`,
    };
  }
  for (const [scenario, endpoints] of Object.entries(json.scenarios)) {
    for (const [endpoint, value] of Object.entries(isObject(endpoints) ? endpoints : {})) {
      const p95 = isObject(value) ? value.p95 : undefined;
      if (typeof p95 !== 'number' || !Number.isFinite(p95) || p95 <= 0) {
        return { problem: `${path}: ${scenario}: ${endpoint} has no positive p95` };
      }
    }
  }
  return { run: json };
}

/** scenario -> endpoint -> p95 of one run, as "scenario\tendpoint" keys. */
function p95sOf(run) {
  const p95s = new Map();
  for (const [scenario, endpoints] of Object.entries(run.scenarios)) {
    for (const [endpoint, value] of Object.entries(endpoints)) {
      p95s.set(`${scenario}\t${endpoint}`, value.p95);
    }
  }
  return p95s;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function main() {
  const { commit, out, runs } = parseCli();
  const problems = [];
  /** topology -> [{ path, run }] in argument order */
  const byTopology = new Map();
  for (const { topology, path } of runs) {
    const { run, problem } = readRun(path);
    if (problem) {
      problems.push(problem);
      continue;
    }
    if (!byTopology.has(topology)) byTopology.set(topology, []);
    byTopology.get(topology).push({ path, run });
  }
  if (problems.length > 0) abort(problems);

  const topologies = {};
  for (const [topology, entries] of byTopology) {
    const p95s = entries.map(({ run }) => p95sOf(run));
    const keys = new Set(p95s.flatMap((map) => [...map.keys()]));
    for (const [index, map] of p95s.entries()) {
      for (const key of keys) {
        if (!map.has(key)) {
          const [scenario, endpoint] = key.split('\t');
          problems.push(`${entries[index].path}: missing ${topology}/${scenario}: ${endpoint}`);
        }
      }
    }
    const medians = {};
    for (const key of keys) {
      const [scenario, endpoint] = key.split('\t');
      medians[scenario] ??= {};
      medians[scenario][endpoint] = { p95: median(p95s.map((map) => map.get(key) ?? 0)) };
    }
    topologies[topology] = { runs: entries.map(({ run }) => run), median: medians };
  }
  if (problems.length > 0) abort(problems);

  const baseline = `${JSON.stringify({ format: BASELINE_FORMAT, commit, topologies }, null, 2)}\n`;
  if (out) {
    writeFileSync(out, baseline);
    console.error(`k6-baseline: wrote ${out} (${[...byTopology.keys()].join(', ')})`);
  } else {
    process.stdout.write(baseline);
  }
}

main();
