// Verifies each domain's `./api` subpath (program spec §12 "Gateway image"):
//  1. a domain that declares exports["./api"] points it at src/api/index.ts (source) and
//     dist/api/index.js (build), and its import graph (type-only imports excluded) reaches no core,
//     gRPC-server or messaging module, handler, relay, cron, persistence, Stripe or security file, and
//     imports no persistence, scheduling, mail, JWT-signing or hashing package;
//  2. the gateway's src/ imports a domain only as `@domain/<x>/api` (or its `-contracts` package),
//     so G-12's file tracing ships the gateway without core and persistence code.
// --require-all: a domain without "./api" is an error too.
//
//   node scripts/check-api-subpaths.mjs [--root <repo>] [--require-all]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { collectSpecifiers, traceImports } from './docker/trace-imports.mjs';

const { values: args } = parseArgs({
  options: {
    root: { type: 'string', default: process.cwd() },
    'require-all': { type: 'boolean', default: false },
  },
});
const root = resolve(args.root);

/** Files an ./api graph must never reach (path relative to the package's src/). */
const FORBIDDEN_FILES = [
  [/(?:^|\/)[^/]+-core\.module\.ts$/, 'a core module'],
  [/(?:^|\/)[^/]+-grpc\.module\.ts$/, 'a gRPC server module'],
  [/(?:^|\/)[^/]+-messaging\.module\.ts$/, 'a messaging module'],
  [/\.handler\.ts$/, 'a command/query/event handler'],
  [/\.relay\.ts$/, 'an event relay'],
  [/\.cron\.ts$/, 'a scheduled job'],
  [/^infrastructure\/persistence\//, 'persistence'],
  [/^infrastructure\/stripe\//, 'the Stripe adapter'],
  [/^infrastructure\/security\//, 'password hashing or token issuance'],
  [/^presentation\/grpc\//, 'a gRPC server controller'],
];
/** Packages an ./api graph must never import. */
const FORBIDDEN_PACKAGES = new Set([
  '@nestjs/jwt',
  '@nestjs/schedule',
  '@node-rs/argon2',
  '@platform/cassandra',
  '@platform/database',
  '@platform/mailer',
  'cassandra-driver',
  'drizzle-orm',
  'postgres',
  'stripe',
]);
/** Apps that reach domains only through ./api (the image-size contract of G-12). */
const API_ONLY_APPS = ['gateway'];
const API_EXPORT = {
  '@repo/source': './src/api/index.ts',
  types: './src/api/index.ts',
  default: './dist/api/index.js',
};

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const posix = (path) => path.split('\\').join('/');
const isFile = (path) => existsSync(path) && statSync(path).isFile();

/** NodeNext source layout: `./x.js` is `./x.ts` on disk; bare specifiers are not followed. */
function resolveSource(specifier, fromFile) {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base.replace(/\.js$/, '.ts'), base, join(base, 'index.ts')];
  return candidates.find(isFile);
}

function listSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSources(path);
    return /\.ts$/.test(entry.name) && !/\.(?:spec|e2e-spec|int-spec|d)\.ts$/.test(entry.name)
      ? [path]
      : [];
  });
}

const problems = [];
const domainsDir = join(root, 'domains');
const domains = existsSync(domainsDir)
  ? readdirSync(domainsDir, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(domainsDir, entry.name, 'package.json')),
      )
      .map((entry) => entry.name)
      .sort()
  : [];

const withApi = new Set();
for (const domain of domains) {
  const dir = join(domainsDir, domain);
  const manifest = readJson(join(dir, 'package.json'));
  const api = manifest.exports?.['./api'];
  if (api === undefined) {
    if (args['require-all'])
      problems.push(`${manifest.name}: package.json declares no "./api" export`);
    continue;
  }
  withApi.add(manifest.name);
  if (JSON.stringify(api) !== JSON.stringify(API_EXPORT)) {
    problems.push(`${manifest.name}: exports["./api"] must be ${JSON.stringify(API_EXPORT)}`);
    continue;
  }
  const src = join(dir, 'src');
  const entry = join(src, 'api', 'index.ts');
  if (!isFile(entry)) {
    problems.push(`${manifest.name}: src/api/index.ts is missing`);
    continue;
  }
  const { files, externals, unresolved } = traceImports([entry], resolveSource);
  for (const { file, specifier } of unresolved) {
    problems.push(
      `${manifest.name}: unresolved import '${specifier}' in ${posix(relative(root, file))}`,
    );
  }
  for (const file of files) {
    const path = posix(relative(src, file));
    for (const [pattern, what] of FORBIDDEN_FILES) {
      if (pattern.test(path))
        problems.push(`${manifest.name}: ./api reaches ${what} (src/${path})`);
    }
  }
  for (const [name, from] of externals) {
    if (FORBIDDEN_PACKAGES.has(name)) {
      problems.push(`${manifest.name}: ./api imports ${name} (${posix(relative(root, from))})`);
    }
  }
}

for (const app of API_ONLY_APPS) {
  const src = join(root, 'apps', app, 'src');
  if (!existsSync(src)) continue;
  for (const file of listSources(src)) {
    for (const specifier of collectSpecifiers(readFileSync(file, 'utf8'))) {
      const match = /^(@domain\/[^/]+)(\/.*)?$/.exec(specifier);
      if (match === null || match[1].endsWith('-contracts') || !withApi.has(match[1])) continue;
      if (match[2] !== '/api') {
        problems.push(
          `apps/${app}: ${posix(relative(root, file))} imports ${specifier}; use ${match[1]}/api`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`API subpath check failed:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.info(
  `API subpaths OK (${withApi.size}/${domains.length} domains export ./api; ` +
    `${API_ONLY_APPS.join(', ')} imports domains only through ./api).`,
);
