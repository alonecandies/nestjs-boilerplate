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
});
