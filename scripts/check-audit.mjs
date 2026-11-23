// Advisory gate (CI-1): runs `bun audit --json --production`, drops the advisories that an
// unexpired entry of .github/audit-ignore.json covers, and fails on any high or critical advisory
// left. An expired or malformed ignore entry fails too, whether or not it still matches, so every
// entry is revisited. Moderate and low advisories are listed, never fatal.
//   node scripts/check-audit.mjs [--input <report.json>] [--ignores <file>] [--today YYYY-MM-DD]
// --input reads a saved `bun audit --json` report instead of running bun (fixtures); --ignores
// replaces .github/audit-ignore.json; --today replaces the current UTC date. The exit code of
// `bun audit` is not used (it is 1 for a moderate advisory too): its JSON report is.
// An ignore entry: { "id": "GHSA-xxxx-xxxx-xxxx" (or bun's numeric id), "package": "name",
// "reason": "...", "expires": "YYYY-MM-DD" }; it covers the advisory of that id in that package
// until the end of its expiry day (UTC).
// Exit: 0 nothing blocking, 1 a high or critical advisory, a bad ignore file or an audit error,
// 2 usage.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = join(import.meta.dirname, '..');
const BLOCKING = new Set(['high', 'critical']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GHSA = /GHSA(?:-[0-9a-z]{4}){3}$/i;

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      input: { type: 'string' },
      ignores: { type: 'string' },
      today: { type: 'string' },
    },
  }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(
    'usage: node scripts/check-audit.mjs [--input <report.json>] [--ignores <file>] [--today YYYY-MM-DD]',
  );
  process.exit(2);
}

/** A calendar date in the YYYY-MM-DD form that round-trips through Date (no 2026-02-30). */
const isDate = (value) =>
  typeof value === 'string' &&
  DATE.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const today = args.today ?? new Date().toISOString().slice(0, 10);
if (!isDate(today)) {
  console.error(`--today must be a YYYY-MM-DD date, got ${today}`);
  process.exit(2);
}

const fail = (message) => {
  console.error(`check-audit: ${message}`);
  process.exit(1);
};

/** The `bun audit --json` report: { [package]: [{ id, url, title, severity, vulnerable_versions }] }. */
function readReport() {
  let text;
  let detail = '';
  if (args.input !== undefined) {
    try {
      text = readFileSync(args.input, 'utf8');
    } catch (error) {
      fail(`cannot read ${args.input}: ${error instanceof Error ? error.message : error}`);
    }
  } else {
    const run = spawnSync('bun', ['audit', '--json', '--production'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (run.error) fail(`cannot run bun audit: ${run.error.message}`);
    text = run.stdout;
    detail = run.stderr.trim();
    // An empty report with a clean exit is "no advisory"; empty with a failed exit is an error
    // (registry unreachable, no lockfile) and must not pass as clean.
    if (text.trim() === '') {
      if (run.status === 0) return {};
      fail(`bun audit exited ${run.status} without a report${detail ? `:\n${detail}` : ''}`);
    }
  }
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    fail(`the audit report is not JSON${detail ? `:\n${detail}` : ''}\n${text.slice(0, 500)}`);
  }
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    fail('the audit report is not an object of packages');
  }
  for (const [name, advisories] of Object.entries(report)) {
    if (!Array.isArray(advisories)) fail(`the audit report entry of ${name} is not a list`);
  }
  return report;
}

/** The ignore entries, validated; any malformed or expired entry is a problem. */
function readIgnores(problems) {
  const file = args.ignores ?? join(ROOT, '.github', 'audit-ignore.json');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`cannot read the ignore file ${file}: ${error instanceof Error ? error.message : error}`);
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.ignores)) {
    fail(`${file} must be an object with an "ignores" list`);
  }
  const active = [];
  parsed.ignores.forEach((entry, index) => {
    const at = `${file} ignores[${index}]`;
    if (entry === null || typeof entry !== 'object') {
      problems.push(`${at} is not an object`);
      return;
    }
    const missing = ['id', 'package', 'reason', 'expires'].filter(
      (key) => typeof entry[key] !== 'string' || entry[key].trim() === '',
    );
    if (missing.length > 0) {
      problems.push(`${at} lacks ${missing.join(', ')}`);
      return;
    }
    if (!GHSA.test(entry.id) && !/^\d+$/.test(entry.id)) {
      problems.push(`${at} id ${entry.id} is neither a GHSA id nor a numeric advisory id`);
      return;
    }
    if (!isDate(entry.expires)) {
      problems.push(`${at} expires ${entry.expires} is not a YYYY-MM-DD date`);
      return;
    }
    if (entry.expires < today) {
      problems.push(
        `${at} (${entry.id} in ${entry.package}) expired on ${entry.expires}: fix the advisory, or renew the entry with a new reason`,
      );
      return;
    }
    active.push({ ...entry, used: false });
  });
  return active;
}

const problems = [];
const report = readReport();
const ignores = readIgnores(problems);

const blocking = [];
const tolerated = [];
const ignored = [];
for (const [pkg, advisories] of Object.entries(report)) {
  for (const advisory of advisories) {
    const severity = String(advisory?.severity ?? 'unknown').toLowerCase();
    const ghsa = String(advisory?.url ?? '').match(GHSA)?.[0];
    const ids = [ghsa?.toUpperCase(), advisory?.id === undefined ? undefined : String(advisory.id)];
    const row = {
      pkg,
      severity,
      id: ghsa ?? String(advisory?.id ?? '?'),
      title: String(advisory?.title ?? ''),
      versions: String(advisory?.vulnerable_versions ?? ''),
      url: String(advisory?.url ?? ''),
    };
    const ignore = ignores.find(
      (entry) =>
        entry.package === pkg &&
        ids.some((id) => id !== undefined && id === entry.id.toUpperCase()),
    );
    if (ignore !== undefined) {
      ignore.used = true;
      ignored.push({ ...row, expires: ignore.expires });
    } else if (BLOCKING.has(severity) || severity === 'unknown') {
      blocking.push(row);
    } else {
      tolerated.push(row);
    }
  }
}

const line = (row) =>
  `  ${row.severity.toUpperCase().padEnd(8)} ${row.pkg} ${row.id} ${row.versions}: ${row.title} ${row.url}`.trimEnd();

if (tolerated.length > 0) {
  console.info(`${tolerated.length} moderate or low advisory(ies), not blocking:`);
  for (const row of tolerated) console.info(line(row));
}
if (ignored.length > 0) {
  console.info(`${ignored.length} advisory(ies) ignored by the ignore file:`);
  for (const row of ignored) console.info(`${line(row)} (until ${row.expires})`);
}
for (const entry of ignores.filter((candidate) => !candidate.used)) {
  console.info(
    `note: the ignore ${entry.id} (${entry.package}) matches no advisory any more; remove it`,
  );
}
if (blocking.length > 0) {
  console.error(
    `${blocking.length} high or critical production advisory(ies) (upgrade, or add a dated entry to .github/audit-ignore.json):`,
  );
  for (const row of blocking) console.error(line(row));
}
for (const problem of problems) console.error(problem);
if (blocking.length > 0 || problems.length > 0) process.exit(1);
console.info(
  `check-audit: no high or critical production advisory (${tolerated.length} below high, ${ignored.length} ignored)`,
);
