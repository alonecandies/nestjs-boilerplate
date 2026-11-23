import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import swc from 'unplugin-swc';
import { defaultServerConditions } from 'vite';
import { defineConfig, type TestProjectInlineConfiguration } from 'vitest/config';

const ROOT = import.meta.dirname;
const INTEGRATION = process.env.INTEGRATION === '1';

/**
 * Unit (and scripts) specs compile Nest modules and run gRPC round trips in-process; under a
 * parallel full run Vitest's 5 s / 10 s defaults flake. e2e and int projects keep their own.
 */
export const UNIT_TEST_TIMEOUT_MS = 15_000;
export const UNIT_HOOK_TIMEOUT_MS = 30_000;

/**
 * Int specs start their containers in `beforeAll`: Citus may take up to
 * `TEST_POSTGRES_STARTUP_TIMEOUT_MS` (default 120 s, see @platform/testing/postgres), Cassandra and
 * Kafka wait up to 180 s (`TEST_CASSANDRA_STARTUP_TIMEOUT_MS`, `withStartupTimeout` in
 * outbox-kafka-delivery.int-spec.ts). The hook timeout is the largest of those budgets plus a minute,
 * so a container that never becomes healthy fails with its own message and not as a hook timeout.
 * scripts/vitest-config.spec.ts scans the specs and helpers for every budget they set. An invalid
 * env value keeps the default here; startTestPostgres refuses it.
 */
export const FIXED_CONTAINER_START_BUDGET_MS = 180_000;
export const INT_HOOK_MARGIN_MS = 60_000;
export function intHookTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const startup = Number(env.TEST_POSTGRES_STARTUP_TIMEOUT_MS);
  return (
    Math.max(
      FIXED_CONTAINER_START_BUDGET_MS,
      Number.isInteger(startup) && startup > 0 ? startup : 0,
    ) + INT_HOOK_MARGIN_MS
  );
}

/** reflect-metadata first (decorator metadata), then the repo setup (silent Nest logger). */
export const SETUP_FILES = ['reflect-metadata', join(ROOT, 'vitest.setup.ts')];

type WorkspaceDir = 'apps' | 'domains' | 'libs';

export interface WorkspacePackage {
  /** Vitest project name: the folder name, `<domain>-contracts` for domains/<domain>/contracts. */
  name: string;
  root: string;
}

/**
 * Every folder under apps/, domains/ and libs/ that has a package.json is a Vitest project named
 * after it. A domain's nested contracts package (domains/<x>/contracts) is the project
 * `<x>-contracts`; the domain's own project only includes its src/ and test/ folders.
 */
const packagesIn = (dir: WorkspaceDir): WorkspacePackage[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(ROOT, dir, entry.name, 'package.json')),
    )
    .flatMap((entry) => {
      const root = join(ROOT, dir, entry.name);
      const contracts = join(root, 'contracts');
      return existsSync(join(contracts, 'package.json'))
        ? [
            { name: entry.name, root },
            { name: `${entry.name}-contracts`, root: contracts },
          ]
        : [{ name: entry.name, root }];
    });

export const unitProject = ({ name, root }: WorkspacePackage): TestProjectInlineConfiguration => ({
  extends: true,
  test: {
    name,
    root,
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    testTimeout: UNIT_TEST_TIMEOUT_MS,
    hookTimeout: UNIT_HOOK_TIMEOUT_MS,
  },
});

const e2eProject = ({ name, root }: WorkspacePackage): TestProjectInlineConfiguration => ({
  extends: true,
  test: {
    name: `${name}:e2e`,
    root,
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

/** Integration tests need Docker (testcontainers) — opt in with INTEGRATION=1. */
const intProject = ({ name, root }: WorkspacePackage): TestProjectInlineConfiguration => ({
  extends: true,
  test: {
    name: `${name}:int`,
    root,
    include: ['src/**/*.int-spec.ts', 'test/**/*.int-spec.ts'],
    testTimeout: 120_000,
    hookTimeout: intHookTimeoutMs(),
  },
});

/**
 * Vitest needs unique project names: a lib that shares a domain's folder name (libs/ai, the
 * platform client, and domains/ai, the context) is the project `platform-<name>`.
 */
export const withUniqueLibNames = (
  libPackages: readonly WorkspacePackage[],
  domainPackages: readonly WorkspacePackage[],
): WorkspacePackage[] => {
  const taken = new Set(domainPackages.map((pkg) => pkg.name));
  return libPackages.map((pkg) =>
    taken.has(pkg.name) ? { ...pkg, name: `platform-${pkg.name}` } : pkg,
  );
};

const domains = packagesIn('domains');
const libs = withUniqueLibNames(packagesIn('libs'), domains);
const apps = packagesIn('apps');

/** Repo tooling under scripts/ (e.g. the layer boundary check), specs only. */
export const scriptsProject: TestProjectInlineConfiguration = {
  extends: true,
  test: {
    name: 'scripts',
    root: join(ROOT, 'scripts'),
    include: ['**/*.spec.ts'],
    testTimeout: UNIT_TEST_TIMEOUT_MS,
    hookTimeout: UNIT_HOOK_TIMEOUT_MS,
  },
};

export default defineConfig({
  root: ROOT,
  plugins: [
    // SWC (not Oxc/esbuild) — same transformer as the build, so emitDecoratorMetadata (Nest DI by
    // type) behaves identically in tests and production.
    swc.vite({
      tsconfigFile: false,
      swcrc: false,
      module: { type: 'es6' },
      jsc: {
        target: 'es2024',
        parser: { syntax: 'typescript', decorators: true },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
          useDefineForClassFields: false,
        },
        keepClassNames: true,
      },
    }),
  ],
  // Vitest (Vite >= 6) reads ssr.resolve.conditions for Node tests and forwards them as --conditions.
  // Goal: tests resolve EXACTLY what Node 24 resolves in production, so no package loads twice.
  //  - '@repo/source': workspace libs resolve to their TS sources (no lib build needed).
  //  - 'module-sync': Node >= 22.10 honours it natively; dual packages such as graphql 17 list it
  //    before 'node'/'require'. Without it Vite picks graphql's CJS build for inlined sources while
  //    Node-loaded externals (Apollo, graphql-scalars, ...) get the ESM build → two graphql realms
  //    ("Cannot use GraphQLSchema from another module or realm").
  //  - Vite's defaults minus 'module' (bundler-only) and 'development|production' (Node never sets it).
  ssr: {
    resolve: {
      conditions: [
        '@repo/source',
        'module-sync',
        ...defaultServerConditions.filter((c) => c !== 'module' && c !== 'development|production'),
      ],
    },
  },
  test: {
    globals: true,
    setupFiles: SETUP_FILES,
    // Nest apps hold sockets/timers; forks is the most robust pool for them.
    pool: 'forks',
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: [
        'apps/*/src/**/*.ts',
        'domains/*/src/**/*.ts',
        'domains/*/contracts/src/**/*.ts',
        'libs/*/src/**/*.ts',
      ],
      exclude: ['**/generated/**', '**/*.spec.ts', '**/*.int-spec.ts', '**/index.ts', '**/main.ts'],
      reporter: ['text-summary', 'html', 'lcov'],
    },
    projects: [
      ...domains.map(unitProject),
      ...libs.map(unitProject),
      ...apps.map(unitProject),
      ...apps.map(e2eProject),
      scriptsProject,
      ...(INTEGRATION
        ? [...domains.map(intProject), ...libs.map(intProject), ...apps.map(intProject)]
        : []),
    ],
  },
});
