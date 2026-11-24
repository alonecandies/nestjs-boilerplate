import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, 'assemble-image.mjs');
const roots: string[] = [];

type Tree = Record<string, string | object>;

function write(root: string, tree: Tree): void {
  for (const [path, content] of Object.entries(tree)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
}

const pkg = (name: string, extra: object = {}) => ({ name, version: '1.0.0', ...extra });
const ws = (name: string, dependencies: Record<string, string>, exports?: object) => ({
  name,
  type: 'module',
  ...(exports ? { exports } : { exports: { '.': { default: './dist/index.js' } } }),
  dependencies,
});

/**
 * --out: a filtered production install (root node_modules, workspace symlinks, manifests);
 * --build: the build stage (src + dist).
 */
function fixture(
  appModule = "import { api } from '@domain/orders/api';\nexport const AppModule = api;\n",
) {
  const root = mkdtempSync(join(tmpdir(), 'assemble-image-'));
  roots.push(root);
  const out = join(root, 'out');
  const build = join(root, 'build');
  const manifests: Tree = {
    'package.json': { workspaces: ['apps/*', 'domains/*', 'libs/*'] },
    'apps/api/package.json': ws('@app/api', {
      '@domain/orders': 'workspace:*',
      'used-lib': '1.0.0',
      'logger-lib': '1.0.0',
      'unused-lib': '1.0.0',
    }),
    'domains/orders/package.json': ws(
      '@domain/orders',
      { '@platform/unused': 'workspace:*', 'heavy-orm': '1.0.0' },
      { '.': { default: './dist/index.js' }, './api': { default: './dist/api/index.js' } },
    ),
    'libs/unused/package.json': ws('@platform/unused', {}),
  };
  write(out, manifests);
  write(out, {
    'bun.lock': '',
    'node_modules/used-lib/package.json': pkg('used-lib', {
      dependencies: { 'dep-of-used': '1.0.0' },
      peerDependencies: { 'peer-of-used': '1.0.0', 'missing-peer': '1.0.0' },
    }),
    'node_modules/used-lib/index.js': 'module.exports = 1;\n',
    'node_modules/used-lib/node_modules/nested-dep/package.json': pkg('nested-dep'),
    // Every package has an entry file: the existing runtime-dependency check resolves each
    // declared dependency with module.findPackageJSON, which needs a resolvable main.
    'node_modules/dep-of-used/package.json': pkg('dep-of-used'),
    'node_modules/dep-of-used/index.js': 'module.exports = 3;\n',
    'node_modules/peer-of-used/package.json': pkg('peer-of-used'),
    'node_modules/peer-of-used/index.js': 'module.exports = 4;\n',
    'node_modules/logger-lib/package.json': pkg('logger-lib'),
    'node_modules/logger-lib/index.js': 'module.exports = 5;\n',
    'node_modules/unused-lib/package.json': pkg('unused-lib'),
    'node_modules/unused-lib/index.js': 'module.exports = 6;\n',
    'node_modules/heavy-orm/package.json': pkg('heavy-orm'),
    'node_modules/heavy-orm/index.js': 'module.exports = 2;\n',
    'node_modules/.bin/heavy': '#!/bin/sh\n',
  });
  mkdirSync(join(out, 'node_modules/@app'), { recursive: true });
  mkdirSync(join(out, 'node_modules/@domain'), { recursive: true });
  mkdirSync(join(out, 'node_modules/@platform'), { recursive: true });
  symlinkSync('../../apps/api', join(out, 'node_modules/@app/api'));
  symlinkSync('../../domains/orders', join(out, 'node_modules/@domain/orders'));
  symlinkSync('../../libs/unused', join(out, 'node_modules/@platform/unused'));
  write(build, manifests);
  write(build, {
    'apps/api/src/main.ts': '',
    'apps/api/dist/main.js': [
      "import { AppModule } from './app.module.js';",
      "import used from 'used-lib';",
      "const pretty = createRequire(import.meta.url).resolve('logger-lib');",
      'console.log(AppModule, used, pretty);',
      '',
    ].join('\n'),
    'apps/api/dist/instrument.js': "export const instrumented = await import('node:os');\n",
    'apps/api/dist/app.module.js': appModule,
    'domains/orders/src/proto/orders.proto': 'syntax = "proto3";\n',
    'domains/orders/dist/proto/orders.proto': 'syntax = "proto3";\n',
    'domains/orders/dist/index.js':
      "export * from './api/index.js';\nexport { orm } from './persistence.js';\n",
    'domains/orders/dist/persistence.js': "import orm from 'heavy-orm';\nexport { orm };\n",
    'domains/orders/dist/api/index.js': '// re-exported by the root\nexport const api = 1;\n',
    'domains/orders/dist/api/index.js.map': '{}',
    'libs/unused/dist/index.js': 'export const unused = 1;\n',
  });
  return { out, build };
}

function assemble(dirs: { out: string; build: string }, ...flags: string[]) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--app', 'api', '--build', dirs.build, '--out', dirs.out, ...flags],
    { encoding: 'utf8' },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('assemble-image file tracing', () => {
  it('keeps what the entrypoints reach and deletes the rest', () => {
    const dirs = fixture();
    const { status, output } = assemble(dirs);
    expect(output).toContain('[assemble] traced');
    expect(status).toBe(0);
    const kept = (path: string) => existsSync(join(dirs.out, path));
    // Workspace files: traced JS, all non-JS assets of a traced package.
    expect(kept('apps/api/dist/main.js')).toBe(true);
    expect(kept('apps/api/dist/app.module.js')).toBe(true);
    expect(kept('domains/orders/dist/api/index.js')).toBe(true);
    expect(kept('domains/orders/dist/proto/orders.proto')).toBe(true);
    expect(kept('domains/orders/dist/index.js')).toBe(false);
    expect(kept('domains/orders/dist/persistence.js')).toBe(false);
    // An untraced workspace package and its symlink are gone.
    expect(kept('libs/unused')).toBe(false);
    expect(kept('node_modules/@platform/unused')).toBe(false);
    // Third-party: imported, resolved by string, their dependencies and installed peers stay.
    expect(kept('node_modules/used-lib/index.js')).toBe(true);
    expect(kept('node_modules/used-lib/node_modules/nested-dep/package.json')).toBe(false);
    expect(kept('node_modules/dep-of-used/package.json')).toBe(true);
    expect(kept('node_modules/peer-of-used/package.json')).toBe(true);
    expect(kept('node_modules/logger-lib/package.json')).toBe(true);
    expect(kept('node_modules/heavy-orm')).toBe(false);
    expect(kept('node_modules/unused-lib')).toBe(false);
    expect(kept('node_modules/.bin')).toBe(false);
    expect(kept('bun.lock')).toBe(false);
  });

  it('copies everything with --trace false (the Dockerfile escape hatch)', () => {
    const dirs = fixture();
    const { status } = assemble(dirs, '--trace', 'false');
    expect(status).toBe(0);
    expect(existsSync(join(dirs.out, 'domains/orders/dist/persistence.js'))).toBe(true);
    expect(existsSync(join(dirs.out, 'node_modules/heavy-orm/index.js'))).toBe(true);
  });

  it('keeps a package named with --keep', () => {
    const dirs = fixture();
    expect(assemble(dirs, '--keep', 'heavy-orm').status).toBe(0);
    expect(existsSync(join(dirs.out, 'node_modules/heavy-orm/index.js'))).toBe(true);
  });

  it('fails on an unresolvable relative import', () => {
    const dirs = fixture("import { x } from './missing.js';\nexport const AppModule = x;\n");
    const { status, output } = assemble(dirs);
    expect(status).toBe(1);
    expect(output).toContain("apps/api/dist/app.module.js: cannot resolve './missing.js'");
  });

  it('passes the load check when every import survived', () => {
    const dirs = fixture();
    const { status, output } = assemble(dirs, '--verify-load', 'true');
    expect(output).toContain('[assemble] load check passed');
    expect(status).toBe(0);
  });

  it('fails the load check on a computed import the tracer cannot see', () => {
    const dirs = fixture(
      "const name = ['heavy', 'orm'].join('-');\nexport const AppModule = await import(name);\n",
    );
    const { status, output } = assemble(dirs, '--verify-load', 'true');
    expect(status).toBe(1);
    expect(output).toContain('load check failed');
  });
});

/** Adds a one-off CLI `src/cli/<name>.ts` to the fixture app, with its compiled `dist/cli/<name>.js`. */
function withCli(dirs: { out: string; build: string }, name: string, js: string | undefined): void {
  write(dirs.build, { [`apps/api/src/cli/${name}.ts`]: '' });
  if (js !== undefined) write(dirs.build, { [`apps/api/dist/cli/${name}.js`]: js });
}

describe('assemble-image one-off CLIs (src/cli/*.ts)', () => {
  // heavy-orm and domains/orders/dist/persistence.js are pruned when only the three base
  // entrypoints are traced (see above), so keeping them proves the CLI is an entrypoint.
  const replayCli = "import { orm } from '@domain/orders';\nexport const cli = orm;\n";

  it('traces dist/cli/<name>.js next to main, instrument and migrate', () => {
    const dirs = fixture();
    withCli(dirs, 'replay', replayCli);
    const { status, output } = assemble(dirs);
    expect(output).toContain('[assemble] traced');
    expect(status).toBe(0);
    const kept = (path: string) => existsSync(join(dirs.out, path));
    expect(kept('apps/api/dist/cli/replay.js')).toBe(true);
    expect(kept('domains/orders/dist/index.js')).toBe(true);
    expect(kept('domains/orders/dist/persistence.js')).toBe(true);
    expect(kept('node_modules/heavy-orm/index.js')).toBe(true);
  });

  it('ignores specs and declarations under src/cli', () => {
    const dirs = fixture();
    withCli(dirs, 'replay', replayCli);
    write(dirs.build, {
      'apps/api/src/cli/replay.spec.ts': '',
      'apps/api/src/cli/types.d.ts': '',
    });
    expect(assemble(dirs).status).toBe(0);
  });

  it('leaves integration and e2e specs under src/cli out of the image', () => {
    const dirs = fixture();
    withCli(dirs, 'x', replayCli);
    // Even when compiled to dist/cli, a spec is not an entrypoint: tracing prunes it.
    withCli(dirs, 'x.int-spec', 'export {};\n');
    withCli(dirs, 'x.e2e-spec', 'export {};\n');
    const { status, output } = assemble(dirs);
    expect(output).toContain('[assemble] traced');
    expect(status).toBe(0);
    const kept = (path: string) => existsSync(join(dirs.out, path));
    expect(kept('apps/api/dist/cli/x.js')).toBe(true);
    expect(kept('apps/api/dist/cli/x.int-spec.js')).toBe(false);
    expect(kept('apps/api/dist/cli/x.e2e-spec.js')).toBe(false);
  });

  it('ships a CLI whose name ends in -test or -spec, and still skips the repo spec suffixes', () => {
    const dirs = fixture();
    withCli(dirs, 'load-test', replayCli);
    withCli(dirs, 'smoke-spec', 'export {};\n');
    withCli(dirs, 'x', 'export {};\n');
    withCli(dirs, 'x.spec', 'export {};\n');
    withCli(dirs, 'x.test', 'export {};\n');
    withCli(dirs, 'x.int-spec', 'export {};\n');
    withCli(dirs, 'x.e2e-spec', 'export {};\n');
    write(dirs.build, { 'apps/api/src/cli/types.d.ts': '' });
    const { status, output } = assemble(dirs);
    expect(output).toContain('[assemble] traced');
    expect(status).toBe(0);
    const kept = (path: string) => existsSync(join(dirs.out, path));
    expect(kept('apps/api/dist/cli/load-test.js')).toBe(true);
    expect(kept('apps/api/dist/cli/smoke-spec.js')).toBe(true);
    expect(kept('node_modules/heavy-orm/index.js')).toBe(true);
    for (const spec of ['x.spec', 'x.test', 'x.int-spec', 'x.e2e-spec']) {
      expect(kept(`apps/api/dist/cli/${spec}.js`)).toBe(false);
    }
  });

  it('fails when a src/cli/<name>.ts was not compiled to dist/cli/<name>.js', () => {
    const dirs = fixture();
    withCli(dirs, 'replay', undefined);
    const { status, output } = assemble(dirs);
    expect(status).toBe(1);
    expect(output).toContain('@app/api: dist/cli/replay.js is missing');
  });

  it('the load check imports every CLI (run without arguments, it must only print its usage)', () => {
    const dirs = fixture();
    withCli(
      dirs,
      'replay',
      "process.stderr.write('usage: replay <topic>\\n');\nprocess.exitCode = 2;\n",
    );
    const { status, output } = assemble(dirs, '--verify-load', 'true');
    expect(output).toContain('[assemble] load check passed');
    expect(status).toBe(0);
  });

  it('fails the load check on a CLI import the tracer cannot see', () => {
    const dirs = fixture();
    withCli(
      dirs,
      'replay',
      "const name = ['heavy', 'orm'].join('-');\nexport const cli = await import(name);\n",
    );
    const { status, output } = assemble(dirs, '--verify-load', 'true');
    expect(status).toBe(1);
    expect(output).toContain('load check failed');
  });
});
