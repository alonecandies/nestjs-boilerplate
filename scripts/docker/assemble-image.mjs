// Assembles the runtime file tree of ONE app inside the Dockerfile `assemble` stage.
//
//   node assemble-image.mjs --app <folder under apps/> --build <build-stage repo> --out <prod-deps repo>
//
// Input: `--out` is the output of `bun install --production --filter ./apps/<app>` (hoisted linker:
// every package in the ROOT node_modules, workspace packages symlinked as node_modules/<scope>/<name>),
// plus the package.json of every workspace package. `--build` is the build stage (src + dist).
// It then:
//  1. computes the app's workspace closure from the `dependencies` graph (devDependencies ignored);
//  2. deletes every workspace package outside that closure (they carry no runtime code), keeping the
//     path down to a nested package that is in it (domains/identity/contracts inside domains/identity);
//  3. copies each closure member's compiled dist/ from the build stage;
//  4. fails the build when something the process needs at runtime is missing:
//     - a non-TS asset under src/ (.proto, .hbs, .cql, .sql, migration meta …) that is not in dist/,
//     - a declared runtime dependency that the filtered production install did not provide,
//     - a workspace symlink that is dangling, or the app's dist/main.js / dist/instrument.js, or its
//       dist/migrate.js when the app has a src/migrate.ts (the migration release job), or a
//       dist/cli/<name>.js for each one-off CLI src/cli/<name>.ts (specs and .d.ts excluded);
//  4b. with --trace true (default), follows the static imports of dist/main.js, dist/instrument.js,
//      dist/migrate.js and dist/cli/*.js through the closure's dist/ (workspace packages file by file, via
//      their exports maps; third-party packages by name) and deletes every untraced JS file, every workspace
//      package without a traced file, and every node_modules package outside the manifest closure
//      (dependencies, optional and installed peer dependencies) of the imported packages. Non-JS assets of
//      traced packages stay. --keep a,b keeps extra packages; --verify-load true then imports
//      dist/app.module.js and every dist/cli/*.js once. Importing a CLI runs it with no arguments, so a
//      CLI must then only print its usage (and set an exit code): it must not read config or connect.
//  5. removes install-only files (bun.lock, bunfig.toml, patches/);
//  6. with --prune true, deletes from node_modules what Node never reads at runtime: type declarations,
//     TS sources (Node refuses to strip types under node_modules), source maps (not loaded without
//     --enable-source-maps) and Markdown docs (license/notice files are kept), plus build-only
//     packages such as `typescript` (an optional peer of @nestjs/graphql/swagger, used only by
//     their CLI plugins) unless an installed package hard-depends on them. Our own dist/ is untouched.
// Pure Node (no dependencies): it runs on the toolchain image before anything is installed globally.
import { spawnSync } from 'node:child_process';
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
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { packageNameOf, traceImports } from './trace-imports.mjs';

const WORKSPACE_SCOPES = ['@app/', '@domain/', '@platform/'];
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
    trace: { type: 'string', default: 'true' },
    'verify-load': { type: 'string', default: 'false' },
    keep: { type: 'string', default: '' },
  },
});
const { app, build, out } = args;
const prune = args.prune === 'true';
const trace = args.trace === 'true';
const verifyLoad = args['verify-load'] === 'true';
const extraKeep = args.keep.split(',').filter(Boolean);
if (!app || !build || !out) {
  fail('usage: assemble-image.mjs --app <name> --build <dir> --out <dir>');
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// Folders matched by one root `workspaces` glob such as "domains/*/contracts" (`*` = one folder).
function expandWorkspaceGlob(pattern) {
  let dirs = [''];
  for (const segment of pattern.split('/')) {
    dirs = dirs.flatMap((dir) => {
      if (segment !== '*') return [dir ? `${dir}/${segment}` : segment];
      if (!existsSync(join(out, dir))) return [];
      return readdirSync(join(out, dir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => (dir ? `${dir}/${entry.name}` : entry.name));
    });
  }
  return dirs;
}

/** name ("@platform/x") -> { dir: "libs/x", manifest } for every workspace package in --out. */
const workspacePatterns = readJson(join(out, 'package.json')).workspaces ?? [];
const workspace = new Map();
for (const dir of workspacePatterns.flatMap(expandWorkspaceGlob)) {
  const manifestPath = join(out, dir, 'package.json');
  if (existsSync(manifestPath)) {
    const manifest = readJson(manifestPath);
    workspace.set(manifest.name, { dir, manifest });
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
  if (!pkg)
    fail(
      `workspace dependency ${name} matches no root workspaces glob (${workspacePatterns.join(', ')})`,
    );
  closure.set(name, pkg);
  for (const dep of Object.keys(pkg.manifest.dependencies ?? {})) {
    if (WORKSPACE_SCOPES.some((scope) => dep.startsWith(scope))) pending.push(dep);
  }
}

// 2. Prune everything outside the closure.
const kept = new Set([...closure.values()].map((pkg) => pkg.dir));
for (const { dir } of workspace.values()) {
  if (!kept.has(dir)) pruneWorkspaceDir(dir);
}

// dist/migrate.js is the release job of an app that owns Postgres migration sets (src/migrate.ts);
// the gateway and notifications-service have none, so it is required only where the source exists.
const entrypoints = ['main.js', 'instrument.js'];
if (existsSync(join(build, appPackage.dir, 'src', 'migrate.ts'))) entrypoints.push('migrate.js');
// One-off jobs run from the image (`node dist/cli/<name>.js …`, e.g. dist/cli/dlq-replay.js).
const CLI_SOURCE = /^[^.][^/]*(?<!\.d|\.spec|\.test)\.ts$/;
const cliDir = join(build, appPackage.dir, 'src', 'cli');
const cliEntrypoints = existsSync(cliDir)
  ? readdirSync(cliDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && CLI_SOURCE.test(entry.name))
      .map((entry) => `cli/${entry.name.replace(/\.ts$/, '.js')}`)
      .sort()
  : [];
entrypoints.push(...cliEntrypoints);

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
      // A dangling symlink (e.g. node_modules/@platform/x -> a pruned folder) throws here.
      if (!found || !existsSync(realpathSync(found))) throw new Error('not found');
    } catch {
      problems.push(`${name}: runtime dependency "${dep}" is not installed`);
    }
  }
}

for (const entrypoint of entrypoints) {
  if (!existsSync(join(out, appPackage.dir, 'dist', entrypoint))) {
    problems.push(`${appPackage.manifest.name}: dist/${entrypoint} is missing`);
  }
}

// 4b. File tracing (program spec §12 "Gateway image").
let traceSummary = '';
if (trace && problems.length === 0) {
  const appDist = join(out, appPackage.dir, 'dist');
  const traced = traceImports(
    entrypoints.map((entrypoint) => join(appDist, entrypoint)),
    resolveDist,
  );
  for (const { file, specifier } of traced.unresolved) {
    problems.push(`${relative(out, file)}: cannot resolve '${specifier}'`);
  }
  if (problems.length === 0) traceSummary = pruneUntraced(traced);
}

if (problems.length > 0) {
  fail(`image tree for ${app} is incomplete:\n  - ${problems.join('\n  - ')}`);
}

// 5. Install-only files never reach the runtime image.
for (const file of INSTALL_ONLY) rmSync(join(out, file), { recursive: true, force: true });

console.info(
  `[assemble] ${app}: ${closure.size} workspace packages (${[...kept].sort().join(', ')}), ` +
    `${assetCount} assets verified, ${dependencyCount} runtime dependencies resolved` +
    (traceSummary ? `\n[assemble] ${traceSummary}` : ''),
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

/** dist/ resolution as Node does it at runtime: relative paths as written, workspace packages through
 * their exports map (`default` condition); anything else is an external package. */
function resolveDist(specifier, fromFile) {
  if (specifier.startsWith('.')) {
    const target = resolve(dirname(fromFile), specifier);
    return existsSync(target) && statSync(target).isFile() ? target : undefined;
  }
  const name = packageNameOf(specifier);
  const member = name === undefined ? undefined : closure.get(name);
  if (member === undefined) return undefined;
  const entry = member.manifest.exports?.[`.${specifier.slice(name.length)}`];
  const file = typeof entry === 'string' ? entry : entry?.default;
  if (typeof file !== 'string') {
    problems.push(`${relative(out, fromFile)}: ${name} does not export '${specifier}'`);
    return undefined;
  }
  return join(out, member.dir, file);
}

/** The installed package `name` as Node's node_modules lookup finds it from `fromPath`. */
function findInstalled(name, fromPath) {
  let dir = statSync(fromPath).isDirectory() ? fromPath : dirname(fromPath);
  for (;;) {
    const manifest = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(manifest)) return realpathSync(manifest);
    if (dir === out || dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
}

function pruneUntraced(traced) {
  const tracedFiles = new Set(traced.files);
  const tracedPackages = new Set([appPackage.manifest.name]);
  for (const [name, { dir }] of closure) {
    const prefix = `${join(out, dir, 'dist')}${sep}`;
    if (traced.files.some((file) => file.startsWith(prefix))) tracedPackages.add(name);
  }

  // Workspace: drop untraced packages (and their node_modules symlinks), then untraced JS files.
  let removedPackages = 0;
  let removedFiles = 0;
  const untraced = [...closure].filter(([name]) => !tracedPackages.has(name));
  for (const [, { dir }] of untraced) kept.delete(dir);
  for (const [name, { dir }] of untraced) {
    pruneWorkspaceDir(dir);
    rmSync(join(out, 'node_modules', name), { recursive: true, force: true });
    removedPackages += 1;
  }
  for (const name of tracedPackages) {
    const dist = join(out, closure.get(name).dir, 'dist');
    for (const file of listFiles(dist)) {
      const path = join(dist, file);
      if (/\.[cm]?js$/.test(file) && !tracedFiles.has(path)) {
        rmSync(path);
        rmSync(`${path}.map`, { force: true });
        removedFiles += 1;
      }
    }
  }

  // Third-party: the manifest closure of every imported (or --keep) package.
  const keepDirs = new Set();
  const pending = [...traced.externals].map(([name, from]) => [name, from]);
  for (const name of extraKeep) pending.push([name, join(out, appPackage.dir)]);
  while (pending.length > 0) {
    const [name, from] = pending.pop();
    const manifestPath = findInstalled(name, from);
    if (manifestPath === undefined) continue; // an optional or peer dependency that is not installed
    const dir = dirname(manifestPath);
    if (keepDirs.has(dir)) continue;
    keepDirs.add(dir);
    const manifest = readJson(manifestPath);
    const deps = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };
    for (const dep of Object.keys(deps)) pending.push([dep, dir]);
  }
  let removedModules = 0;
  const pruneModules = (modules) => {
    if (!existsSync(modules)) return;
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      const path = join(modules, entry.name);
      if (entry.name === '.bin') {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (entry.name.startsWith('.')) continue;
      const children = entry.name.startsWith('@')
        ? readdirSync(path).map((child) => [`${entry.name}/${child}`, join(path, child)])
        : [[entry.name, path]];
      for (const [name, packagePath] of children) {
        if (WORKSPACE_SCOPES.some((scope) => name.startsWith(scope))) continue; // handled above
        if (!keepDirs.has(realpathSync(packagePath))) {
          rmSync(packagePath, { recursive: true, force: true });
          removedModules += 1;
        } else {
          pruneModules(join(packagePath, 'node_modules'));
        }
      }
      if (entry.name.startsWith('@') && readdirSync(path).length === 0)
        rmSync(path, { recursive: true });
    }
  };
  pruneModules(join(out, 'node_modules'));
  for (const name of tracedPackages) pruneModules(join(out, closure.get(name).dir, 'node_modules'));

  if (verifyLoad) verifyAppLoads();
  return (
    `traced ${traced.files.length} files in ${tracedPackages.size} workspace packages; removed ` +
    `${removedFiles} workspace files, ${removedPackages} workspace packages, ${removedModules} node_modules packages`
  );
}

/** Imports dist/app.module.js and every dist/cli/*.js once in a child process: tracing must never ship
 * a module graph that cannot load (computed imports, string-only requires the tracer cannot see).
 * A CLI runs without arguments there (it prints its usage and sets an exit code); a module that
 * fails to load rejects its import, so the child exits non-zero, and the CLIs' exit code is reset. */
function verifyAppLoads() {
  const appDist = join(out, appPackage.dir, 'dist');
  const modules = ['app.module.js', ...cliEntrypoints]
    .map((file) => join(appDist, file))
    .filter((file) => existsSync(file));
  if (modules.length === 0) return;
  const imports = modules
    .map((file) => `await import(${JSON.stringify(pathToFileURL(file).href)});`)
    .join(' ');
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `${imports} process.exitCode = 0;`],
    {
      cwd: join(out, appPackage.dir),
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH, NODE_ENV: 'development', OTEL_SDK_DISABLED: 'true' },
    },
  );
  if (result.status !== 0) {
    const reason = result.error?.message ?? (result.signal ? `killed by ${result.signal}` : '');
    fail(
      `load check failed for ${modules.map((file) => relative(out, file)).join(', ')} ` +
        `(exit ${result.status}${reason ? `, ${reason}` : ''}):\n` +
        `${result.stderr || result.stdout}`,
    );
  }
  console.info('[assemble] load check passed');
}

/**
 * Deletes workspace folder `dir` (relative to --out), except the path down to any kept package
 * nested inside it: pruning domains/identity must not delete a kept domains/identity/contracts.
 */
function pruneWorkspaceDir(dir) {
  const nestedKept = [...kept].filter((keptDir) => keptDir.startsWith(`${dir}/`));
  if (nestedKept.length === 0) {
    rmSync(join(out, dir), { recursive: true, force: true });
    return;
  }
  for (const entry of readdirSync(join(out, dir))) {
    const child = `${dir}/${entry}`;
    if (kept.has(child)) continue;
    if (nestedKept.some((keptDir) => keptDir.startsWith(`${child}/`))) pruneWorkspaceDir(child);
    else rmSync(join(out, child), { recursive: true, force: true });
  }
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
