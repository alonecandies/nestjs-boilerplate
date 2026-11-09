// Fails when the root .env.example drifts from what reads it.
//  1. Config: every env var a config namespace schema reads must be documented above the
//     compose-only section (as `KEY=` or `# KEY=`), and nothing unknown may be listed there.
//     Namespaces are libs/config/src/namespaces/*.config.ts (read first), then every *.config.ts
//     under a src/ folder of libs/*, domains/* (contracts packages included) and apps/*. Files
//     outside src/ (domains/<x>/drizzle.config.ts, vitest.config.ts) are not namespaces.
//  2. Compose: every variable a root compose file (docker-compose*.yml, compose*.yaml)
//     interpolates (`${VAR}`, `${VAR:-x}`, `$VAR`; `$$` is a literal `$`; comment lines are
//     skipped) must be documented somewhere in .env.example, and every variable of the
//     compose-only section must be interpolated by a compose file or be one compose reads itself.
// Reads the SOURCES (no build needed):
//   node scripts/check-env-example.mjs [--root <dir>] [--list]
// --list prints every config variable with the file that declares it (platform files first; the
// first file that declares a variable owns it). --root checks another tree (fixtures).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: { root: { type: 'string' }, list: { type: 'boolean', default: false } },
});
const root = args.root ?? join(import.meta.dirname, '..');
const namespacesDir = join(root, 'libs', 'config', 'src', 'namespaces');
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
// Read by docker compose itself (not interpolated), documented in the compose-only section.
const COMPOSE_BUILTINS = new Set(['COMPOSE_PROFILES', 'COMPOSE_PROJECT_NAME', 'COMPOSE_FILE']);
const COMPOSE_SECTION = /^# docker compose ONLY/m;
const COMPOSE_FILE = /^(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/;
const COMPOSE_VAR = /(?<!\$)\$(?:\{([A-Z][A-Z0-9_]*)|([A-Z][A-Z0-9_]*))/g;
const DOCUMENTED = /^#?\s*([A-Z][A-Z0-9_]*)=/gm;

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

const byName = (a, b) => (a.name < b.name ? -1 : 1);

/** Every `*.config.ts` below a `src/` folder under `dir` (<pkg>/src, domains/<x>/contracts/src). */
function* configFiles(dir, inSrc = false) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* configFiles(path, inSrc || entry.name === 'src');
    else if (inSrc && entry.name.endsWith('.config.ts')) yield path;
  }
}

/** Top-level keys of the namespace schemas (env var names are UPPER_CASE) → declaring file. */
const configVars = new Map();
const readFiles = new Set();
function collect(file) {
  if (readFiles.has(file)) return;
  readFiles.add(file);
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
for (const dir of ['libs', 'domains', 'apps']) {
  for (const file of configFiles(join(root, dir))) collect(file);
}
if (args.list) {
  for (const [key, file] of [...configVars].sort(([a], [b]) => (a < b ? -1 : 1))) {
    console.info(`${key}\t${file}`);
  }
}

const example = readFileSync(join(root, '.env.example'), 'utf8');
const [appSection = '', composeSection = ''] = example.split(COMPOSE_SECTION);
const documentedIn = (text) => new Set([...text.matchAll(DOCUMENTED)].map(([, key]) => key));
const documented = documentedIn(appSection);
const documentedAnywhere = documentedIn(example);
const errors = [];

for (const [key, file] of configVars) {
  if (!documented.has(key)) errors.push(`missing from .env.example: ${key} (${file})`);
}
for (const key of documented) {
  if (!configVars.has(key) && !RUNTIME_VARS.has(key)) {
    errors.push(`.env.example lists ${key}, which no config namespace (libs, domains, apps) reads`);
  }
}

/** Root compose files and the variables each interpolates (comment lines skipped). */
const composeFiles = readdirSync(root)
  .filter((name) => COMPOSE_FILE.test(name))
  .sort();
const composeVars = new Set();
for (const name of composeFiles) {
  const lines = readFileSync(join(root, name), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'));
  for (const [, braced, bare] of lines.join('\n').matchAll(COMPOSE_VAR)) {
    const key = braced ?? bare;
    if (composeVars.has(key)) continue;
    composeVars.add(key);
    if (!documentedAnywhere.has(key)) {
      errors.push(`${name} interpolates ${key}, which .env.example does not document`);
    }
  }
}
if (composeFiles.length > 0) {
  for (const key of documentedIn(composeSection)) {
    if (!composeVars.has(key) && !COMPOSE_BUILTINS.has(key)) {
      errors.push(`.env.example compose section lists ${key}, which no compose file interpolates`);
    }
  }
}

for (const error of errors) console.error(error);
if (errors.length > 0) process.exit(1);
console.info(
  `.env.example documents all ${configVars.size} config variables (${platformCount} from libs/config, ${configVars.size - platformCount} from domains, apps and other libs)`,
);
if (composeFiles.length > 0) {
  console.info(
    `.env.example documents all ${composeVars.size} docker compose variables (${composeFiles.join(', ')})`,
  );
}
