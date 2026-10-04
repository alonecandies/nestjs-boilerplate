// Fails when the root .env.example drifts from @app/config: every env var a config namespace
// schema reads must be documented there (as `KEY=` or `# KEY=`), and nothing unknown may be
// listed above the compose-only section. Reads the schema SOURCES (no build needed):
//   node scripts/check-env-example.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const namespacesDir = join(root, 'libs', 'config', 'src', 'namespaces');
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

/** Top-level keys of the namespace schemas (env var names are UPPER_CASE). */
const configVars = new Map();
for (const file of readdirSync(namespacesDir).filter((f) => f.endsWith('.config.ts'))) {
  const source = readFileSync(join(namespacesDir, file), 'utf8');
  for (const body of objectBodies(source)) {
    for (const [, key] of body.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)) {
      configVars.set(key, file.replace('.config.ts', ''));
    }
  }
}
if (configVars.size === 0) {
  console.error(`no env vars found under ${namespacesDir}: did the schema layout change?`);
  process.exit(1);
}

const example = readFileSync(join(root, '.env.example'), 'utf8');
const [appSection = ''] = example.split(COMPOSE_SECTION);
const documented = new Set(
  [...appSection.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(([, key]) => key),
);

const missing = [...configVars].filter(([key]) => !documented.has(key));
const unknown = [...documented].filter((key) => !configVars.has(key) && !RUNTIME_VARS.has(key));

for (const [key, ns] of missing)
  console.error(`missing from .env.example: ${key} (${ns} namespace)`);
for (const key of unknown)
  console.error(`.env.example lists ${key}, which @app/config does not read`);
if (missing.length > 0 || unknown.length > 0) process.exit(1);
console.info(`.env.example documents all ${configVars.size} @app/config variables`);
