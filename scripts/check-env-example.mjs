// Fails when the root .env.example drifts from the config namespaces: every env var a namespace
// schema reads must be documented there (as `KEY=` or `# KEY=`), and nothing unknown may be
// listed above the compose-only section. The namespaces are the platform ones
// (libs/config/src/namespaces/*.config.ts) and the domain-owned ones: every *.config.ts under a
// src/ folder of domains/ (contracts packages included; domains/<x>/drizzle.config.ts is not).
// Reads the schema SOURCES (no build needed):
//   node scripts/check-env-example.mjs [--root <dir>] [--list]
// --list prints every variable with the file that declares it (platform files first; the first
// file that declares a variable owns it). --root checks another tree (fixtures).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: { root: { type: 'string' }, list: { type: 'boolean', default: false } },
});
const root = args.root ?? join(import.meta.dirname, '..');
const namespacesDir = join(root, 'libs', 'config', 'src', 'namespaces');
const domainsDir = join(root, 'domains');
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'generated']);
// Variables read by Node or the OTel SDK themselves, documented next to the config ones.
const RUNTIME_VARS = new Set([
  'OTEL_SERVICE_NAME',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_TRACES_SAMPLER',
  'OTEL_TRACES_SAMPLER_ARG',
  'UV_THREADPOOL_SIZE',
  'NODE_OPTIONS',
]);
const COMPOSE_SECTION = /^# docker compose ONLY/m;

/** Body of every `z.object({ ... })` literal (brace-balanced: values contain `{ min: 1 }` etc.). */
function objectBodies(source) {
  const bodies = [];
  for (const match of source.matchAll(/z\s*\.object\(\{/g)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
    }
    bodies.push(source.slice(start, i - 1));
  }
  return bodies;
}

/** Every `*.config.ts` below a `src/` folder under `dir` (domains/<x>/src, domains/<x>/contracts/src). */
function* domainConfigFiles(dir, inSrc = false) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* domainConfigFiles(path, inSrc || entry.name === 'src');
    else if (inSrc && entry.name.endsWith('.config.ts')) yield path;
  }
}

/** Top-level keys of the namespace schemas (env var names are UPPER_CASE) → declaring file. */
const configVars = new Map();
function collect(file) {
  for (const body of objectBodies(readFileSync(file, 'utf8'))) {
    for (const [, key] of body.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)) {
      if (!configVars.has(key)) configVars.set(key, relative(root, file));
    }
  }
}
for (const file of readdirSync(namespacesDir)
  .filter((f) => f.endsWith('.config.ts'))
  .sort()) {
  collect(join(namespacesDir, file));
}
const platformCount = configVars.size;
if (platformCount === 0) {
  console.error(`no env vars found under ${namespacesDir}: did the schema layout change?`);
  process.exit(1);
}
for (const file of domainConfigFiles(domainsDir)) collect(file);
if (args.list) {
  for (const [key, file] of [...configVars].sort(([a], [b]) => (a < b ? -1 : 1))) {
    console.info(`${key}\t${file}`);
  }
}

const example = readFileSync(join(root, '.env.example'), 'utf8');
const [appSection = ''] = example.split(COMPOSE_SECTION);
const documented = new Set(
  [...appSection.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(([, key]) => key),
);

const missing = [...configVars].filter(([key]) => !documented.has(key));
const unknown = [...documented].filter((key) => !configVars.has(key) && !RUNTIME_VARS.has(key));

for (const [key, file] of missing) console.error(`missing from .env.example: ${key} (${file})`);
for (const key of unknown)
  console.error(
    `.env.example lists ${key}, which no config namespace (libs/config, domains) reads`,
  );
if (missing.length > 0 || unknown.length > 0) process.exit(1);
const domainCount = configVars.size - platformCount;
console.info(
  `.env.example documents all ${configVars.size} config variables (${platformCount} from libs/config, ${domainCount} from domains)`,
);
