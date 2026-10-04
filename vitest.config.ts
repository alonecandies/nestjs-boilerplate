import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import swc from 'unplugin-swc';
import { defaultServerConditions } from 'vite';
import { defineConfig, type TestProjectInlineConfiguration } from 'vitest/config';

const ROOT = import.meta.dirname;
const INTEGRATION = process.env.INTEGRATION === '1';

/** Every folder under apps/ and libs/ that has a package.json is a Vitest project named after it. */
const packagesIn = (dir: 'apps' | 'libs'): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(ROOT, dir, entry.name, 'package.json')),
    )
    .map((entry) => entry.name);

const unitProject = (dir: 'apps' | 'libs', name: string): TestProjectInlineConfiguration => ({
  extends: true,
  test: {
    name,
    root: join(ROOT, dir, name),
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
  },
});

const e2eProject = (name: string): TestProjectInlineConfiguration => ({
  extends: true,
  test: {
    name: `${name}:e2e`,
    root: join(ROOT, 'apps', name),
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

/** Integration tests need Docker (testcontainers) — opt in with INTEGRATION=1. */
const intProject = (dir: 'apps' | 'libs', name: string): TestProjectInlineConfiguration => ({
  extends: true,
  test: {
    name: `${name}:int`,
    root: join(ROOT, dir, name),
    include: ['src/**/*.int-spec.ts', 'test/**/*.int-spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});

const libs = packagesIn('libs');
const apps = packagesIn('apps');

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
  //  - '@app/source': workspace libs resolve to their TS sources (no lib build needed).
  //  - 'module-sync': Node >= 22.10 honours it natively; dual packages such as graphql 17 list it
  //    before 'node'/'require'. Without it Vite picks graphql's CJS build for inlined sources while
  //    Node-loaded externals (Apollo, graphql-scalars, ...) get the ESM build → two graphql realms
  //    ("Cannot use GraphQLSchema from another module or realm").
  //  - Vite's defaults minus 'module' (bundler-only) and 'development|production' (Node never sets it).
  ssr: {
    resolve: {
      conditions: [
        '@app/source',
        'module-sync',
        ...defaultServerConditions.filter((c) => c !== 'module' && c !== 'development|production'),
      ],
    },
  },
  test: {
    globals: true,
    setupFiles: ['reflect-metadata'],
    // Nest apps hold sockets/timers; forks is the most robust pool for them.
    pool: 'forks',
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**/*.ts', 'libs/*/src/**/*.ts'],
      exclude: ['**/generated/**', '**/*.spec.ts', '**/*.int-spec.ts', '**/index.ts', '**/main.ts'],
      reporter: ['text-summary', 'html', 'lcov'],
    },
    projects: [
      ...libs.map((name) => unitProject('libs', name)),
      ...apps.map((name) => unitProject('apps', name)),
      ...apps.map((name) => e2eProject(name)),
      ...(INTEGRATION
        ? [
            ...libs.map((name) => intProject('libs', name)),
            ...apps.map((name) => intProject('apps', name)),
          ]
        : []),
    ],
  },
});
