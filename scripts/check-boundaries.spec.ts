import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, 'check-boundaries.mjs');

/** path -> file content: a string for sources, an object for package.json manifests. */
type Tree = Record<string, string | object>;

const roots: string[] = [];

/** Writes `tree` into a fresh temporary repo root. */
function repo(tree: Tree): string {
  const root = mkdtempSync(join(tmpdir(), 'check-boundaries-'));
  roots.push(root);
  for (const [path, content] of Object.entries(tree)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

function check(tree: Tree): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', repo(tree)], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const manifest = (name: string, dependencies: Record<string, string> = {}) => ({
  name,
  dependencies,
});

/** A layout that follows every rule: app -> domain -> contracts -> platform. */
const LAYERED: Tree = {
  'apps/api/package.json': manifest('@app/api', { '@domain/orders': 'workspace:*' }),
  'apps/api/src/main.ts': "import { OrdersModule } from '@domain/orders';\n",
  'domains/orders/package.json': manifest('@domain/orders', {
    '@domain/orders-contracts': 'workspace:*',
    '@domain/users-contracts': 'workspace:*',
    '@platform/kernel': 'workspace:*',
  }),
  'domains/orders/src/index.ts': [
    "import { ORDER_PLACED_EVENT } from '@domain/orders-contracts';",
    "import type { User } from '@domain/users-contracts';",
    "import { kernel } from '@platform/kernel';",
    "import { local } from './local.js';",
    '',
  ].join('\n'),
  'domains/orders/src/local.ts': 'export const local = 1;\n',
  'domains/orders/contracts/package.json': manifest('@domain/orders-contracts', {
    '@platform/contracts': 'workspace:*',
    zod: 'catalog:',
  }),
  'domains/orders/contracts/src/index.ts': [
    "import { join } from 'node:path';",
    "import { defineEventContract } from '@platform/contracts';",
    "import { z } from 'zod';",
    '',
  ].join('\n'),
  'domains/orders/contracts/src/index.spec.ts':
    "import { loadGrpcPackages } from '@platform/contracts/testing';\n",
  'domains/users/package.json': manifest('@domain/users', {
    '@domain/users-contracts': 'workspace:*',
  }),
  'domains/users/contracts/package.json': manifest('@domain/users-contracts', {
    '@platform/contracts': 'workspace:*',
  }),
  'libs/contracts/package.json': manifest('@platform/contracts'),
  'libs/kernel/package.json': manifest('@platform/kernel', {
    '@platform/contracts': 'workspace:*',
  }),
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('scripts/check-boundaries.mjs', () => {
  it('accepts the layered layout and counts nested contracts packages', () => {
    const { status, output } = check(LAYERED);
    expect(output).toContain('Layer boundaries OK (7 packages');
    expect(status).toBe(0);
  });

  it('rejects a domain that depends on another domain instead of its contracts', () => {
    const { status, output } = check({
      ...LAYERED,
      'domains/orders/package.json': manifest('@domain/orders', {
        '@domain/users': 'workspace:*',
      }),
      'domains/orders/src/user.spec.ts': "vi.mock('@domain/users');\n",
    });
    expect(status).toBe(1);
    expect(output).toContain(
      'domains/orders/package.json: dependencies must not include "@domain/users"',
    );
    expect(output).toContain('domains/orders/src/user.spec.ts: must not import "@domain/users"');
    expect(output).toContain('only through its @domain/<x>-contracts package');
  });

  it('rejects a domain that reaches into another domain through a subpath', () => {
    const { status, output } = check({
      ...LAYERED,
      'domains/orders/src/fake.ts': "import { FakeUsers } from '@domain/users/testing';\n",
    });
    expect(status).toBe(1);
    expect(output).toContain('must not import "@domain/users/testing"');
  });

  it.each([
    [
      'another platform package',
      "import { kernel } from '@platform/kernel';\n",
      '@platform/kernel',
    ],
    ['its own domain', "import { Order } from '@domain/orders';\n", '@domain/orders'],
    [
      'another contracts package',
      "import type { User } from '@domain/users-contracts';\n",
      '@domain/users-contracts',
    ],
    ['an app', "import { main } from '@app/api';\n", '@app/api'],
  ])('rejects a contracts package that imports %s', (_label, source, specifier) => {
    const { status, output } = check({
      ...LAYERED,
      'domains/orders/contracts/src/extra.ts': source,
    });
    expect(status).toBe(1);
    expect(output).toContain(
      `domains/orders/contracts/src/extra.ts: must not import "${specifier}"`,
    );
    expect(output).toContain('only @platform/contracts and third-party packages');
  });

  it('rejects a relative import that leaves its package', () => {
    const { status, output } = check({
      ...LAYERED,
      'domains/orders/contracts/src/leak.ts': "import { local } from '../../src/local.js';\n",
      'domains/orders/src/peek.ts': "import { ORDER } from '../contracts/src/index.js';\n",
    });
    expect(status).toBe(1);
    expect(output).toContain(
      'domains/orders/contracts/src/leak.ts: must not reach outside its package through "../../src/local.js"',
    );
    expect(output).toContain(
      'domains/orders/src/peek.ts: must not reach outside its package through "../contracts/src/index.js"',
    );
  });

  it('requires domains/<x>/contracts to be named @domain/<x>-contracts', () => {
    const { status, output } = check({
      ...LAYERED,
      'domains/orders/contracts/package.json': manifest('@domain/orders-api'),
    });
    expect(status).toBe(1);
    expect(output).toContain(
      'domains/orders/contracts/package.json: name must be "@domain/orders-contracts" (is "@domain/orders-api")',
    );
  });

  it('keeps platform packages free of domains, contracts packages included', () => {
    const { status, output } = check({
      ...LAYERED,
      'libs/kernel/src/index.ts': "import type { User } from '@domain/users-contracts';\n",
    });
    expect(status).toBe(1);
    expect(output).toContain('libs/kernel/src/index.ts: must not import "@domain/users-contracts"');
  });

  it('keeps testing subpaths out of production source', () => {
    const { status, output } = check({
      ...LAYERED,
      'apps/api/src/wiring.ts': "import { FakeOrders } from '@domain/orders/testing';\n",
      'apps/api/test/support/app.ts': "import { FakeOrders } from '@domain/orders/testing';\n",
      'domains/orders/src/testing/fake-orders.ts':
        "import { signTestToken } from '@platform/kernel/testing';\n",
      'domains/orders/src/orders.int-spec.ts':
        "import { signTestToken } from '@platform/kernel/testing';\n",
    });
    expect(status).toBe(1);
    expect(output).toContain(
      'apps/api/src/wiring.ts: must not import "@domain/orders/testing" (test-only code',
    );
    expect(output).not.toContain('apps/api/test/support/app.ts');
    expect(output).not.toContain('fake-orders.ts');
    expect(output).not.toContain('orders.int-spec.ts');
  });

  it.each([
    [
      'the test-only package',
      "import { createMock } from '@platform/testing';\n",
      '@platform/testing',
    ],
    [
      'a subpath of the test-only package',
      "import { createMock } from '@platform/testing/mocks';\n",
      '@platform/testing/mocks',
    ],
  ])('keeps %s (@platform/testing) out of production source', (_label, source, specifier) => {
    const { status, output } = check({
      ...LAYERED,
      'apps/api/src/wiring.ts': source,
      'libs/kernel/src/helpers.ts': source,
      // Test code may import it.
      'apps/api/test/support/app.ts': source,
      'domains/orders/src/orders.spec.ts': source,
      'domains/orders/src/testing/fake-orders.ts': source,
    });
    expect(status).toBe(1);
    expect(output).toContain('Layer boundary violations (2):');
    for (const file of ['apps/api/src/wiring.ts', 'libs/kernel/src/helpers.ts']) {
      expect(output).toContain(
        `${file}: must not import "${specifier}" (test-only code must not reach production source)`,
      );
    }
  });

  it.each([
    ['export * from', "export * from '@domain/users';\n"],
    ['export { x } from', "export { User } from '@domain/users';\n"],
    ['import type', "import type { User } from '@domain/users';\n"],
    ['a side-effect import', "import '@domain/users';\n"],
    ['a dynamic import()', "const users = await import('@domain/users');\n"],
    ['require()', "const users = require('@domain/users');\n"],
    ['vi.mock', "vi.mock('@domain/users');\n"],
    ['vi.doMock', "vi.doMock('@domain/users');\n"],
    ['vi.importActual', "const users = await vi.importActual('@domain/users');\n"],
    ['vi.importMock', "const users = await vi.importMock('@domain/users');\n"],
    [
      'vi.importActual<T> (a type argument)',
      "const users = await vi.importActual<UsersModule>('@domain/users');\n",
    ],
    [
      'vi.importMock<T> (a type argument)',
      "const users = await vi.importMock<Record<string, unknown>>('@domain/users');\n",
    ],
    ['declare module', "declare module '@domain/users' {}\n"],
  ])('sees %s reaching another domain', (_form, source) => {
    const { status, output } = check({ ...LAYERED, 'domains/orders/src/users.spec.ts': source });
    expect(status).toBe(1);
    expect(output).toContain('Layer boundary violations (1):');
    expect(output).toContain('domains/orders/src/users.spec.ts: must not import "@domain/users"');
  });

  it('lets an app depend on and import a contracts package', () => {
    const { status, output } = check({
      ...LAYERED,
      'apps/api/package.json': manifest('@app/api', {
        '@domain/orders': 'workspace:*',
        '@domain/orders-contracts': 'workspace:*',
      }),
      'apps/api/src/events.ts': "import { ORDER_PLACED_EVENT } from '@domain/orders-contracts';\n",
    });
    expect(output).toContain('Layer boundaries OK (7 packages');
    expect(status).toBe(0);
  });

  it('reports each import once: test-only code in production source, the domain rule in tests', () => {
    const fake = "import { FakeUsers } from '@domain/users/testing';\n";
    const { status, output } = check({
      ...LAYERED,
      'domains/orders/src/fake.ts': fake,
      'domains/orders/src/fake.spec.ts': fake,
    });
    expect(status).toBe(1);
    expect(output).toContain('Layer boundary violations (2):');
    expect(output).toContain(
      'domains/orders/src/fake.ts: must not import "@domain/users/testing" (test-only code must not reach production source)',
    );
    expect(output).toContain(
      'domains/orders/src/fake.spec.ts: must not import "@domain/users/testing" (a domain may import another domain only through its @domain/<x>-contracts package)',
    );
  });

  it('counts only test suffixes and test/ or testing/ folders as test code', () => {
    const fake = "import { FakeOrders } from '@domain/orders/testing';\n";
    const { status, output } = check({
      ...LAYERED,
      'domains/orders/src/tests/helper.ts': fake,
      'domains/orders/src/test-utils.ts': fake,
      'domains/orders/src/orders.e2e-spec.ts': fake,
      'domains/orders/src/orders.test.ts': fake,
    });
    expect(status).toBe(1);
    expect(output).toContain('Layer boundary violations (2):');
    expect(output).toContain(
      'domains/orders/src/tests/helper.ts: must not import "@domain/orders/testing" (test-only code',
    );
    expect(output).toContain(
      'domains/orders/src/test-utils.ts: must not import "@domain/orders/testing" (test-only code',
    );
    expect(output).not.toContain('orders.e2e-spec.ts');
    expect(output).not.toContain('orders.test.ts');
  });

  it('ignores imports in whole-line comments', () => {
    const { status, output } = check({
      ...LAYERED,
      'domains/orders/src/notes.ts': [
        "// import { User } from '@domain/users';",
        '/**',
        ' * Example:',
        " *   import { User } from '@domain/users';",
        " *   vi.mock('../../../users/src/index.js');",
        ' */',
        "  /** export * from '@domain/users'; */",
        'export const notes = 1;',
        '',
      ].join('\n'),
    });
    expect(output).toContain('Layer boundaries OK (7 packages');
    expect(status).toBe(0);
  });

  it('never lets comment handling hide a real import', () => {
    const forbidden = "import { User } from '@domain/users';";
    const { status, output } = check({
      ...LAYERED,
      // A naive /* … */ strip would cut from the `/*` in 'libs/*/src' to the end of the JSDoc below.
      'domains/orders/src/globs.ts': [
        "const GLOBS = ['src/**/*.ts', 'libs/*/src'];",
        forbidden,
        '/** The users port. */',
        '',
      ].join('\n'),
      'domains/orders/src/url.ts': `const DOCS = 'https://example.com/docs'; ${forbidden}\n`,
      'domains/orders/src/after-comment.ts': `/* users */ ${forbidden}\n`,
      // An opener that never closes (here inside a template literal) is not a comment.
      'domains/orders/src/banner.ts': [
        'const BANNER = `',
        '/* generated',
        '`;',
        forbidden,
        '',
      ].join('\n'),
    });
    expect(status).toBe(1);
    expect(output).toContain('Layer boundary violations (4):');
    for (const file of ['globs.ts', 'url.ts', 'after-comment.ts', 'banner.ts']) {
      expect(output).toContain(`domains/orders/src/${file}: must not import "@domain/users"`);
    }
  });

  describe('justified elevation is named only by *.elevated.ts files (outside libs/database/src)', () => {
    const DATABASE: Tree = {
      'libs/database/package.json': manifest('@platform/database'),
      'libs/database/src/rls/rls-elevation.service.ts': [
        "export const ELEVATION_REASONS = Object.freeze(['membership-activity'] as const);",
        'export class RlsElevation { async justified() {} }',
        '',
      ].join('\n'),
    };
    const touch = [
      "import { RlsElevation } from '@platform/database';",
      'export class Touch {',
      '  constructor(private readonly elevation: RlsElevation) {}',
      "  run() { return this.elevation.justified('membership-activity', async () => 1); }",
      '}',
      '',
    ].join('\n');
    const reasons = "import { ELEVATION_REASONS } from '@platform/database';\n";
    const WHY =
      'names RlsElevation.justified or ELEVATION_REASONS outside libs/database/src: only a *.elevated.ts file may';

    it('fails for justified( in a domain service and ELEVATION_REASONS in an app', () => {
      const { status, output } = check({
        ...LAYERED,
        ...DATABASE,
        'domains/orders/src/foo.service.ts': touch,
        'domains/orders/src/bound.ts': 'export const run = (e) => e.justified.bind(e);\n',
        'domains/orders/src/destructured.ts':
          "export const run = ({ justified }) => justified('tenant-bootstrap', async () => 1);\n",
        'apps/api/src/reasons.ts': reasons,
      });
      expect(status).toBe(1);
      expect(output).toContain('Layer boundary violations (4):');
      for (const file of [
        'domains/orders/src/foo.service.ts',
        'domains/orders/src/bound.ts',
        'domains/orders/src/destructured.ts',
        'apps/api/src/reasons.ts',
      ]) {
        expect(output).toContain(`${file}: ${WHY}`);
      }
    });

    it('passes in foo.elevated.ts, inside libs/database/src, in test code and in comments', () => {
      const { status, output } = check({
        ...LAYERED,
        ...DATABASE,
        'domains/orders/src/foo.elevated.ts': touch,
        'domains/orders/src/foo.elevated.spec.ts': reasons,
        'libs/database/test/elevation.int-spec.ts': touch,
        'domains/orders/src/notes.ts': [
          '// this.elevation.justified(…) lives in touch.elevated.ts (elevation justified by a token)',
          'export const notes = 1;',
          '',
        ].join('\n'),
      });
      expect(output).toContain('Layer boundaries OK (8 packages');
      expect(status).toBe(0);
    });
  });

  describe('the system database is named only by *.system-repository.ts files (outside libs/database/src)', () => {
    const SYSTEM: Tree = {
      ...LAYERED,
      'domains/orders/package.json': manifest('@domain/orders', {
        '@domain/orders-contracts': 'workspace:*',
        '@domain/users-contracts': 'workspace:*',
        '@platform/database': 'workspace:*',
        '@platform/kernel': 'workspace:*',
      }),
      'apps/api/package.json': manifest('@app/api', {
        '@domain/orders': 'workspace:*',
        '@platform/database': 'workspace:*',
      }),
      'libs/database/package.json': manifest('@platform/database'),
      'libs/database/src/system/system-database.ts': [
        "export const SYSTEM_DATABASE = Symbol('SYSTEM_DATABASE');",
        'export const InjectSystemDatabase = () => () => undefined;',
        'export class SystemDatabase {}',
        '',
      ].join('\n'),
    };
    const injector = [
      "import { InjectSystemDatabase, type SystemDatabase } from '@platform/database';",
      'export class DrizzleFooRepository {',
      '  constructor(@InjectSystemDatabase() private readonly system: SystemDatabase) {}',
      '}',
      '',
    ].join('\n');
    const WHY =
      'names SystemDatabase, SYSTEM_DATABASE or InjectSystemDatabase outside libs/database/src: only a *.system-repository.ts file may';

    it('fails for InjectSystemDatabase in drizzle-foo.repository.ts and SYSTEM_DATABASE in an app', () => {
      const { status, output } = check({
        ...SYSTEM,
        'domains/orders/src/drizzle-foo.repository.ts': injector,
        'domains/orders/src/via-token.ts':
          "import * as db from '@platform/database';\nexport const token = db.SYSTEM_DATABASE;\n",
        'apps/api/src/system.ts': "export { SystemDatabase as Db } from '@platform/database';\n",
        'libs/database/scripts/backdoor.ts':
          "import { SYSTEM_DATABASE } from '../src/system/system-database.js';\n",
      });
      expect(status).toBe(1);
      expect(output).toContain('Layer boundary violations (4):');
      for (const file of [
        'domains/orders/src/drizzle-foo.repository.ts',
        'domains/orders/src/via-token.ts',
        'apps/api/src/system.ts',
        'libs/database/scripts/backdoor.ts',
      ]) {
        expect(output).toContain(`${file}: ${WHY}`);
      }
    });

    it('passes in drizzle-foo.system-repository.ts, libs/database/src, test code, comments and unrelated packages', () => {
      const { status, output } = check({
        ...SYSTEM,
        'domains/orders/src/drizzle-foo.system-repository.ts': injector,
        'domains/orders/src/drizzle-foo.system-repository.spec.ts': injector,
        'domains/orders/src/errors.ts':
          "import { SystemDatabaseError } from '@platform/database';\nexport const E = SystemDatabaseError;\n",
        'domains/orders/src/notes.ts': [
          '// the purge goes through SystemDatabase in drizzle-foo.system-repository.ts',
          'export const notes = 1;',
          '',
        ].join('\n'),
        'libs/database/test/system-database.int-spec.ts': injector,
        // A package that cannot reach @platform/database may use the words for its own things.
        'libs/kernel/src/admin.ts':
          "const SYSTEM_DATABASE = 'defaultdb';\nexport const db = SYSTEM_DATABASE;\n",
      });
      expect(output).toContain('Layer boundaries OK (8 packages');
      expect(status).toBe(0);
    });
  });
});
