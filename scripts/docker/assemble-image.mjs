// Assembles the runtime file tree of ONE app inside the Dockerfile `assemble` stage.
//
//   node assemble-image.mjs --app <folder under apps/> --build <build-stage repo> --out <prod-deps repo>
//
// Input: `--out` is the output of `bun install --production --filter ./apps/<app>` (hoisted linker:
// every package in the ROOT node_modules, workspace packages symlinked as node_modules/@app/<name>),
// plus the package.json of every workspace package. `--build` is the build stage (src + dist).
// It then:
//  1. computes the app's workspace closure from the `dependencies` graph (devDependencies ignored);
//  2. deletes every apps/* and libs/* folder outside that closure (they carry no runtime code);
//  3. copies each closure member's compiled dist/ from the build stage;
//  4. fails the build when something the process needs at runtime is missing:
//     - a non-TS asset under src/ (.proto, .hbs, .cql, .sql, migration meta …) that is not in dist/,
//     - a declared runtime dependency that the filtered production install did not provide,
//     - a workspace symlink that is dangling, or the app's dist/main.js / dist/instrument.js;
//  5. removes install-only files (bun.lock, bunfig.toml, patches/);
//  6. with --prune true, deletes from node_modules what Node never reads at runtime: type declarations,
//     TS sources (Node refuses to strip types under node_modules), source maps (not loaded without
//     --enable-source-maps) and Markdown docs (license/notice files are kept), plus build-only
//     packages such as `typescript` (an optional peer of @nestjs/graphql/swagger, used only by
//     their CLI plugins) unless an installed package hard-depends on them. Our own dist/ is untouched.
// Pure Node (no dependencies): it runs on the toolchain image before anything is installed globally.
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { findPackageJSON } from 'node:module';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const WORKSPACE_DIRS = ['apps', 'libs'];
const WORKSPACE_SCOPE = '@app/';
const INSTALL_ONLY = ['bun.lock', 'bunfig.toml', 'patches'];
// Source files swc compiles (everything else under src/ is copied verbatim by `copyFiles`).
const COMPILED = /\.(?:[cm]?ts|tsx)$/;
const PRUNABLE_FILE = /\.(?:d\.)?[cm]?tsx?$|\.(?:[cm]?js|[cm]?ts|css)\.map$|\.(?:md|markdown)$/i;
const LEGAL_FILE = /^(?:licen[cs]e|copying|notice|authors|patents)/i;
const BUILD_ONLY_PACKAGES = ['typescript'];
const PACKAGE_MANIFEST = /(?:^|\/node_modules\/)(?:@[^/]+\/)?[^/]+\/package\.json$/;

const { values: args } = parseArgs({
  options: {
    app: { type: 'string' },
    build: { type: 'string' },
    out: { type: 'string' },
    // "true" | "false": a string, so the Dockerfile can pass its build arg through unchanged.
    prune: { type: 'string', default: 'false' },
  },
});
const { app, build, out } = args;
const prune = args.prune === 'true';
if (!app || !build || !out) {
  fail('usage: assemble-image.mjs --app <name> --build <dir> --out <dir>');
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** name ("@app/x") -> { dir: "libs/x", manifest } for every workspace package in --out. */
const workspace = new Map();
for (const parent of WORKSPACE_DIRS) {
  for (const entry of readdirSync(join(out, parent), { withFileTypes: true })) {
    const manifestPath = join(out, parent, entry.name, 'package.json');
    if (entry.isDirectory() && existsSync(manifestPath)) {
      const manifest = readJson(manifestPath);
      workspace.set(manifest.name, { dir: `${parent}/${entry.name}`, manifest });
    }
  }
}

const appPackage = [...workspace.values()].find((pkg) => pkg.dir === `apps/${app}`);
if (!appPackage) fail(`apps/${app}/package.json not found`);

// 1. Workspace closure over runtime `dependencies`.
const closure = new Map();
const pending = [appPackage.manifest.name];
while (pending.length > 0) {
  const name = pending.pop();
  if (closure.has(name)) continue;
  const pkg = workspace.get(name);
  if (!pkg) fail(`workspace dependency ${name} has no package.json under apps/ or libs/`);
  closure.set(name, pkg);
  for (const dep of Object.keys(pkg.manifest.dependencies ?? {})) {
    if (dep.startsWith(WORKSPACE_SCOPE)) pending.push(dep);
  }
}

// 2. Prune everything outside the closure.
const kept = new Set([...closure.values()].map((pkg) => pkg.dir));
for (const { dir } of workspace.values()) {
  if (!kept.has(dir)) rmSync(join(out, dir), { recursive: true, force: true });
}

// 3 + 4. dist/ per closure member, asset and dependency checks.
const problems = [];
let assetCount = 0;
let dependencyCount = 0;
for (const [name, { dir, manifest }] of closure) {
  const builtDist = join(build, dir, 'dist');
  if (!existsSync(builtDist)) {
    problems.push(`${name}: ${dir}/dist was not built`);
    continue;
  }
  const targetDist = join(out, dir, 'dist');
  rmSync(targetDist, { recursive: true, force: true });
  cpSync(builtDist, targetDist, { recursive: true, verbatimSymlinks: true });

  for (const asset of listFiles(join(build, dir, 'src'))) {
    if (COMPILED.test(asset) || asset.split('/').some((part) => part.startsWith('.'))) continue;
    assetCount += 1;
    if (!existsSync(join(out, dir, 'dist', asset))) {
      problems.push(`${name}: asset src/${asset} is missing from dist/ (swc copyFiles)`);
    }
  }

  const base = pathToFileURL(join(out, dir, 'package.json'));
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    dependencyCount += 1;
    try {
      const found = findPackageJSON(dep, base);
      // A dangling symlink (e.g. node_modules/@app/x -> a pruned folder) throws here.
      if (!found || !existsSync(realpathSync(found))) throw new Error('not found');
    } catch {
      problems.push(`${name}: runtime dependency "${dep}" is not installed`);
    }
  }
}

for (const entrypoint of ['main.js', 'instrument.js']) {
  if (!existsSync(join(out, appPackage.dir, 'dist', entrypoint))) {
    problems.push(`${appPackage.manifest.name}: dist/${entrypoint} is missing`);
  }
}

if (problems.length > 0) {
  fail(`image tree for ${app} is incomplete:\n  - ${problems.join('\n  - ')}`);
}

// 5. Install-only files never reach the runtime image.
for (const file of INSTALL_ONLY) rmSync(join(out, file), { recursive: true, force: true });

console.info(
  `[assemble] ${app}: ${closure.size} workspace packages (${[...kept].sort().join(', ')}), ` +
    `${assetCount} assets verified, ${dependencyCount} runtime dependencies resolved`,
);

// 6. Slim node_modules (after the checks, which only need package.json files).
if (prune) {
  const modules = join(out, 'node_modules');
  const files = listFiles(modules);
  const hardDependents = new Map(BUILD_ONLY_PACKAGES.map((name) => [name, []]));
  for (const file of files.filter((f) => PACKAGE_MANIFEST.test(f))) {
    const manifest = readJson(join(modules, file));
    for (const [name, dependents] of hardDependents) {
      if (manifest.dependencies?.[name] || manifest.optionalDependencies?.[name]) {
        dependents.push(manifest.name);
      }
    }
  }
  let removedBytes = 0;
  let removedFiles = 0;
  const removed = [];
  for (const [name, dependents] of hardDependents) {
    const dir = join(modules, name);
    if (!existsSync(dir)) continue;
    if (dependents.length > 0) {
      console.info(`[assemble] keeping ${name}: required by ${dependents.join(', ')}`);
      continue;
    }
    for (const file of listFiles(dir)) removedBytes += statSync(join(dir, file)).size;
    rmSync(dir, { recursive: true, force: true });
    removed.push(name);
  }
  for (const file of files) {
    const name = basename(file);
    if (!PRUNABLE_FILE.test(name) || LEGAL_FILE.test(name)) continue;
    const path = join(modules, file);
    if (!existsSync(path)) continue; // inside a package removed above
    removedBytes += statSync(path).size;
    removedFiles += 1;
    rmSync(path);
  }
  console.info(
    `[assemble] pruned ${removedFiles} files + [${removed.join(', ')}] from node_modules ` +
      `(${(removedBytes / 1024 / 1024).toFixed(1)} MiB)`,
  );
}

/** Relative paths of all regular files under `root` (symlinks are not followed). */
function listFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(root, path));
    }
  };
  walk(root);
  return files;
}

function fail(message) {
  console.error(`[assemble] error: ${message}`);
  process.exit(1);
}
