// Fails when a workspace package crosses the layer boundaries of the repo layout:
//   apps/*     @app/*       deployables: may depend on anything below them
//   domains/*  @domain/*    business contexts: may depend on @platform/* (and on other domains)
//   libs/*     @platform/*  platform + shared kernel: may depend on @platform/* only
// Checks every package.json dependency field AND every module specifier in the sources (tests
// included, because Biome's noUndeclaredDependencies is off for specs), so a platform lib can
// neither declare nor quietly import a domain or an app:
//   node scripts/check-boundaries.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const LAYERS = [
  { dir: 'apps', scope: '@app/', forbidden: [] },
  { dir: 'domains', scope: '@domain/', forbidden: ['@app/'] },
  { dir: 'libs', scope: '@platform/', forbidden: ['@app/', '@domain/'] },
];
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx)$/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'generated']);
// import/export … from 'x', import('x'), require('x'), vi.mock('x'), declare module 'x', import 'x'
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bvi\.mock\s*\(\s*|\bdeclare\s+module\s+|\bimport\s+)['"]([^'"]+)['"]/g;

const problems = [];

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (SOURCE_FILE.test(entry.name)) yield path;
  }
}

let packages = 0;
for (const { dir, scope, forbidden } of LAYERS) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const pkgDir = join(root, dir, entry.name);
    const manifestPath = join(pkgDir, 'package.json');
    if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
    packages += 1;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const where = `${dir}/${entry.name}`;

    if (manifest.name !== `${scope}${entry.name}`) {
      problems.push(
        `${where}/package.json: name must be "${scope}${entry.name}" (is "${manifest.name}")`,
      );
    }
    for (const field of DEPENDENCY_FIELDS) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        if (forbidden.some((prefix) => dep.startsWith(prefix))) {
          problems.push(`${where}/package.json: ${field} must not include "${dep}"`);
        }
      }
    }
    if (forbidden.length === 0) continue;
    for (const file of sourceFiles(pkgDir)) {
      const source = readFileSync(file, 'utf8');
      for (const [, specifier] of source.matchAll(SPECIFIER)) {
        if (forbidden.some((prefix) => specifier.startsWith(prefix))) {
          problems.push(`${relative(root, file)}: must not import "${specifier}"`);
        }
      }
    }
  }
}

if (packages === 0) {
  console.error('no workspace packages found: did the apps/ domains/ libs/ layout change?');
  process.exit(1);
}
if (problems.length > 0) {
  console.error(`Layer boundary violations (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`Layer boundaries OK (${packages} packages: apps -> domains -> libs).`);
