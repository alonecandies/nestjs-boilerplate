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
// Production source must not import a `@<scope>/<pkg>/testing` package subpath or the test-only
// package `@platform/testing` (tests may). Not covered: relative `./testing/...` imports and deeper
// `@<scope>/<pkg>/<dir>/testing` subpaths.
// Justified elevation (B3 Task 6): `RlsElevation.justified()` turns RLS elevation on WITHOUT a
// permission check, so outside libs/database/src only a `*.elevated.ts` file (small, reviewed on its
// own) may name `justified` (a call, a property access, a bracket access) or `ELEVATION_REASONS`.
// Test code is exempt; whole-line comments are ignored.
// System database (B3 Task 7): `SystemDatabase` is the door to the BYPASSRLS `app_system` pool, so
// outside libs/database/src only a `*.system-repository.ts` file may name `SystemDatabase`,
// `SYSTEM_DATABASE` or `InjectSystemDatabase`. The rule covers the packages that can reach it (those
// declaring @platform/database, and @platform/database itself); test code and whole-line comments
// are exempt as above.
// Layer direction inside a domain (audit fixes ARCH-6): a file under a domain package's
// src/application/ or src/domain/ must not import that package's src/infrastructure/ or
// src/presentation/ (dependencies point inward; application code reaches infrastructure through the
// ports in application/ports, bound in the domain's modules). The exceptions are listed in
// LAYER_EXCEPTIONS, each documented in docs/ARCHITECTURE.md §3. Test code is exempt (a spec may
// wire a concrete adapter); the check reads relative specifiers, resolved to the file they name.
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
// import/export … from 'x', import('x'), require('x'), declare module 'x', import 'x', and the
// Vitest loaders vi.mock('x'), vi.doMock('x'), vi.importActual('x') and vi.importMock('x'), also
// with a type argument (vi.importActual<T>('x'); `<typeof import('x')>` is caught by import('x'))
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bvi\.(?:mock|doMock|importActual|importMock)\s*(?:<[^()'"]*>)?\s*\(\s*|\bdeclare\s+module\s+|\bimport\s+)['"]([^'"]+)['"]/g;
// Whole-line comments: a `//` line, or a block comment that starts a line, up to its `*/` (code
// after that stays). Their specifiers (a commented-out import, a JSDoc example) are not imports.
// Comments after code stay, so no string (a glob like 'src/**/*.ts', a URL) can cut real code; the
// blind spot is a template-literal line that starts with `/*` and is closed by a later `*/`.
const LINE_COMMENT = /^[ \t]*(?:\/\/.*|\/\*[\s\S]*?\*\/)/gm;
const CONTRACTS_PACKAGE = /^@domain\/[^/]+-contracts(?:\/|$)/;
const PLATFORM_CONTRACTS = /^@platform\/contracts(?:\/|$)/;
const WORKSPACE_SCOPE = /^@(?:app|domain|platform)\//;
// `@<scope>/<pkg>/testing` subpaths hold fakes and test signers, and `@platform/testing` (any subpath)
// imports vitest: test code may import them, production source never (a fake port or a token signer
// must not be wired into a deployable, and an image has no vitest).
const TEST_ONLY = /^@(?:(?:app|domain|platform)\/[^/]+\/testing|platform\/testing)(?:\/|$)/;
const TEST_CODE =
  /(?:^|[\\/])(?:test|testing)[\\/]|\.(?:spec|e2e-spec|int-spec|test)\.[cm]?[jt]sx?$/;
// `x.justified`, `justified(` / `justified<T>(`, `x['justified']`, `ELEVATION_REASONS`.
const JUSTIFIED_ELEVATION =
  /\.\s*justified\b|\bjustified\s*(?:<[^()]*>)?\s*\(|\[\s*['"`]justified['"`]\s*\]|\bELEVATION_REASONS\b/;
const ELEVATED_FILE = /\.elevated\.ts$/;
const ELEVATION_HOME = '@platform/database';
const SYSTEM_DATABASE_NAME = /\b(?:SystemDatabase|SYSTEM_DATABASE|InjectSystemDatabase)\b/;
const SYSTEM_REPOSITORY_FILE = /\.system-repository\.ts$/;
const DATABASE_PACKAGE = '@platform/database';
// Layer direction inside a domain package (paths relative to the package, `/`-separated).
const INNER_LAYER = /^src\/(?:application|domain)\//;
const OUTER_LAYER = /^src\/(?:infrastructure|presentation)(?:\/|$)/;
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|tsx)$/;
// The documented exceptions (docs/ARCHITECTURE.md §3): a path ending in `/` allows that folder, any
// other path that one module (without its extension). Add an entry only with its paragraph there.
const LAYER_EXCEPTIONS = Object.freeze([
  // identity's PasswordHasher, TokenIssuer and their config namespaces.
  { domain: 'identity', path: 'src/infrastructure/security/' },
  // billing's Stripe adapter, StripeService, and its config namespace (a port would restate the
  // Stripe SDK's types).
  { domain: 'billing', path: 'src/infrastructure/stripe/' },
  // IdentityOutbox: an empty OutboxWriter subclass, the platform library under identity's token.
  { domain: 'identity', path: 'src/infrastructure/persistence/identity-outbox' },
]);
const posix = (path) => path.split(sep).join('/');

/**
 * Why `from` (a file of the domain package `domain`) must not import `to` (the path it resolves to),
 * both relative to the package; null when the layer rule allows it.
 */
function layerViolation(domain, from, to) {
  if (!INNER_LAYER.test(from) || !OUTER_LAYER.test(to)) return null;
  const module = to.replace(SOURCE_EXTENSION, '');
  const allowed = LAYER_EXCEPTIONS.some(
    (exception) =>
      exception.domain === domain &&
      (exception.path.endsWith('/') ? to.startsWith(exception.path) : module === exception.path),
  );
  return allowed
    ? null
    : 'application and domain code must not import infrastructure or presentation: depend on a port in application/ports, or document an exception';
}

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

/** Every workspace package: { dir (absolute), kind, name, domain (the <x> of its folder) }. */
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
  const reachesSystemDatabase =
    pkg.name === DATABASE_PACKAGE ||
    DEPENDENCY_FIELDS.some((field) => Object.hasOwn(manifest[field] ?? {}, DATABASE_PACKAGE));
  for (const file of sourceFiles(pkg.dir)) {
    const source = readFileSync(file, 'utf8').replace(LINE_COMMENT, '');
    const inPackage = relative(pkg.dir, file);
    if (
      reachesSystemDatabase &&
      SYSTEM_DATABASE_NAME.test(source) &&
      !SYSTEM_REPOSITORY_FILE.test(file) &&
      !TEST_CODE.test(inPackage) &&
      !(pkg.name === DATABASE_PACKAGE && inPackage.startsWith(`src${sep}`))
    ) {
      problems.push(
        `${relative(root, file)}: names SystemDatabase, SYSTEM_DATABASE or InjectSystemDatabase outside libs/database/src: only a *.system-repository.ts file may (the system pool bypasses RLS)`,
      );
    }
    if (
      JUSTIFIED_ELEVATION.test(source) &&
      !ELEVATED_FILE.test(file) &&
      !TEST_CODE.test(inPackage) &&
      !(pkg.name === ELEVATION_HOME && inPackage.startsWith(`src${sep}`))
    ) {
      problems.push(
        `${relative(root, file)}: names RlsElevation.justified or ELEVATION_REASONS outside libs/database/src: only a *.elevated.ts file may (justified elevation skips the permission check)`,
      );
    }
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier);
        if (ownerOf(target) !== pkg) {
          problems.push(
            `${relative(root, file)}: must not reach outside its package through "${specifier}"`,
          );
          continue;
        }
        const layer =
          pkg.kind === 'domain' && !TEST_CODE.test(inPackage)
            ? layerViolation(pkg.domain, posix(inPackage), posix(relative(pkg.dir, target)))
            : null;
        if (layer)
          problems.push(`${relative(root, file)}: must not import "${specifier}" (${layer})`);
        continue;
      }
      if (TEST_ONLY.test(specifier) && !TEST_CODE.test(relative(pkg.dir, file))) {
        problems.push(
          `${relative(root, file)}: must not import "${specifier}" (test-only code must not reach production source)`,
        );
        continue;
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
