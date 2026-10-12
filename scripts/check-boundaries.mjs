// Fails when a workspace package crosses the layer boundaries of the repo layout:
//   apps/<x>               @app/<x>                deployables: may depend on anything below them
//   domains/<x>            @domain/<x>             a bounded context: @platform/* and its own
//                                                  contracts; another domain ONLY through that
//                                                  domain's @domain/<y>-contracts package
//   domains/<x>/contracts  @domain/<x>-contracts   the context's published language:
//                                                  @platform/contracts and third-party packages only
//   libs/<x>               @platform/<x>           platform + shared kernel: @platform/* only
// Checks every package.json dependency field AND every module specifier in the sources (tests
// included, because Biome's noUndeclaredDependencies is off for specs), so a package can neither
// declare nor quietly import what its layer forbids. A relative specifier must stay inside its
// own package: reaching into a sibling or a nested package by path is an import too.
//   node scripts/check-boundaries.mjs [--root <repo root>]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { root: { type: 'string' } } });
const root = resolve(args.root ?? join(import.meta.dirname, '..'));

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
const CONTRACTS_PACKAGE = /^@domain\/[^/]+-contracts(?:\/|$)/;
const PLATFORM_CONTRACTS = /^@platform\/contracts(?:\/|$)/;
const WORKSPACE_SCOPE = /^@(?:app|domain|platform)\//;
// `@<scope>/<pkg>/testing` subpaths hold fakes and test signers: test code may import them, production source never
// (a fake port or a token signer must not be wired into a deployable).
const TESTING_SUBPATH = /^@(?:app|domain|platform)\/[^/]+\/testing(?:\/|$)/;
const TEST_CODE =
  /(?:^|[\\/])(?:test|testing)[\\/]|\.(?:spec|e2e-spec|int-spec|test)\.[cm]?[jt]sx?$/;

/** Returns why `specifier` is forbidden in a package of `kind` (for domains: of `domain`), or null. */
function violation(kind, domain, specifier) {
  switch (kind) {
    case 'app':
      return null;
    case 'domain':
      if (specifier.startsWith('@app/')) return 'a domain must not import an app';
      if (
        specifier.startsWith('@domain/') &&
        !CONTRACTS_PACKAGE.test(specifier) &&
        specifier !== `@domain/${domain}` &&
        !specifier.startsWith(`@domain/${domain}/`)
      ) {
        return 'a domain may import another domain only through its @domain/<x>-contracts package';
      }
      return null;
    case 'contracts':
      return WORKSPACE_SCOPE.test(specifier) && !PLATFORM_CONTRACTS.test(specifier)
        ? 'a contracts package may import only @platform/contracts and third-party packages'
        : null;
    case 'lib':
      return specifier.startsWith('@app/') || specifier.startsWith('@domain/')
        ? 'a platform package must not import an app or a domain'
        : null;
    default:
      throw new Error(`unknown package kind ${kind}`);
  }
}

/** Every workspace package: { dir (absolute), where (relative), kind, name, domain? }. */
const packages = [];
const subdirs = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => (a.name < b.name ? -1 : 1))
    : [];
for (const [folder, kind, scope] of [
  ['apps', 'app', '@app/'],
  ['domains', 'domain', '@domain/'],
  ['libs', 'lib', '@platform/'],
]) {
  for (const entry of subdirs(join(root, folder))) {
    const dir = join(root, folder, entry.name);
    if (!existsSync(join(dir, 'package.json'))) continue;
    packages.push({ dir, kind, name: `${scope}${entry.name}`, domain: entry.name });
    if (kind === 'domain' && existsSync(join(dir, 'contracts', 'package.json'))) {
      packages.push({
        dir: join(dir, 'contracts'),
        kind: 'contracts',
        name: `@domain/${entry.name}-contracts`,
        domain: entry.name,
      });
    }
  }
}

const packageDirs = new Set(packages.map((pkg) => pkg.dir));
/** The innermost package that contains `path`, or undefined. */
const ownerOf = (path) =>
  packages
    .filter((pkg) => path === pkg.dir || path.startsWith(`${pkg.dir}${sep}`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];

/** Source files of the package at `dir`, without nested packages (they are checked on their own). */
function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!packageDirs.has(path)) yield* sourceFiles(path);
    } else if (SOURCE_FILE.test(entry.name)) {
      yield path;
    }
  }
}

const problems = [];
for (const pkg of packages) {
  const where = relative(root, pkg.dir);
  const manifest = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8'));
  if (manifest.name !== pkg.name) {
    problems.push(`${where}/package.json: name must be "${pkg.name}" (is "${manifest.name}")`);
  }
  for (const field of DEPENDENCY_FIELDS) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      const reason = violation(pkg.kind, pkg.domain, dep);
      if (reason)
        problems.push(`${where}/package.json: ${field} must not include "${dep}" (${reason})`);
    }
  }
  for (const file of sourceFiles(pkg.dir)) {
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      if (specifier.startsWith('.')) {
        if (ownerOf(resolve(dirname(file), specifier)) !== pkg) {
          problems.push(
            `${relative(root, file)}: must not reach outside its package through "${specifier}"`,
          );
        }
        continue;
      }
      if (TESTING_SUBPATH.test(specifier) && !TEST_CODE.test(relative(pkg.dir, file))) {
        problems.push(
          `${relative(root, file)}: must not import "${specifier}" (test-only code must not reach production source)`,
        );
      }
      const reason = violation(pkg.kind, pkg.domain, specifier);
      if (reason)
        problems.push(`${relative(root, file)}: must not import "${specifier}" (${reason})`);
    }
  }
}

if (packages.length === 0) {
  console.error('no workspace packages found: did the apps/ domains/ libs/ layout change?');
  process.exit(1);
}
if (problems.length > 0) {
  console.error(`Layer boundary violations (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `Layer boundaries OK (${packages.length} packages: apps -> domains -> contracts -> libs).`,
);
