import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, 'check-api-subpaths.mjs');
const REPO_ROOT = join(import.meta.dirname, '..');

type Tree = Record<string, string | object>;
const roots: string[] = [];

function repo(tree: Tree): string {
  const root = mkdtempSync(join(tmpdir(), 'check-api-subpaths-'));
  roots.push(root);
  for (const [path, content] of Object.entries(tree)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

function check(root: string, ...flags: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, ...flags], {
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const API_EXPORT = {
  '@repo/source': './src/api/index.ts',
  types: './src/api/index.ts',
  default: './dist/api/index.js',
};

const manifest = (withApi = true) => ({
  name: '@domain/orders',
  exports: {
    '.': { '@repo/source': './src/index.ts', types: './src/index.ts', default: './dist/index.js' },
    ...(withApi ? { './api': API_EXPORT } : {}),
    './package.json': './package.json',
  },
});

/** A domain whose ./api reaches only presentation and ports. */
const CLEAN: Tree = {
  'domains/orders/package.json': manifest(),
  'domains/orders/src/api/index.ts': [
    "export { OrdersPort } from '../application/ports/orders.port.js';",
    "export { OrdersController } from '../presentation/http/orders.controller.js';",
    '',
  ].join('\n'),
  'domains/orders/src/application/ports/orders.port.ts': 'export abstract class OrdersPort {}\n',
  'domains/orders/src/presentation/http/orders.controller.ts': [
    "import { Controller } from '@nestjs/common';",
    "import type { OrderRow } from '../../infrastructure/persistence/orders.schema.js';",
    "// import { OrdersCoreModule } from '../../orders-core.module.js';",
    "/* import { x } from '../../infrastructure/persistence/orders.schema.js'; */",
    "import { OrdersPort } from '../../application/ports/orders.port.js';",
    'export type Row = OrderRow;',
    '@Controller() export class OrdersController { constructor(readonly port: OrdersPort) {} }',
    '',
  ].join('\n'),
  'domains/orders/src/infrastructure/persistence/orders.schema.ts':
    "import { pgTable } from 'drizzle-orm/pg-core';\nexport type OrderRow = object;\nexport const t = pgTable;\n",
  'domains/orders/src/orders-core.module.ts': 'export class OrdersCoreModule {}\n',
  'apps/gateway/src/app.module.ts': [
    "import { OrdersController } from '@domain/orders/api';",
    "import { ORDERS_PACKAGE } from '@domain/orders-contracts';",
    'export const x = [OrdersController, ORDERS_PACKAGE];',
    '',
  ].join('\n'),
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('check-api-subpaths', () => {
  it('passes a clean ./api graph (comments and import type do not count)', () => {
    const { status, output } = check(repo(CLEAN));
    expect(output).toContain('API subpaths OK (1/1 domains export ./api');
    expect(status).toBe(0);
  });

  it('fails when ./api re-exports a core module', () => {
    const { status, output } = check(
      repo({
        ...CLEAN,
        'domains/orders/src/api/index.ts':
          "export { OrdersCoreModule } from '../orders-core.module.js';\n",
      }),
    );
    expect(status).toBe(1);
    expect(output).toContain(
      '@domain/orders: ./api reaches a core module (src/orders-core.module.ts)',
    );
  });

  it('fails on a dynamic import of persistence and names the forbidden package', () => {
    const { status, output } = check(
      repo({
        ...CLEAN,
        'domains/orders/src/api/index.ts':
          "export const load = () => import('../infrastructure/persistence/orders.schema.js');\n",
      }),
    );
    expect(status).toBe(1);
    expect(output).toContain(
      './api reaches persistence (src/infrastructure/persistence/orders.schema.ts)',
    );
    expect(output).toContain('./api imports drizzle-orm');
  });

  it('fails on a multi-line value import of a handler', () => {
    const { status, output } = check(
      repo({
        ...CLEAN,
        'domains/orders/src/api/index.ts': [
          'import {',
          '  PlaceOrderHandler,',
          "} from '../application/commands/place-order/place-order.handler.js';",
          'export const h = PlaceOrderHandler;',
          '',
        ].join('\n'),
        'domains/orders/src/application/commands/place-order/place-order.handler.ts':
          'export class PlaceOrderHandler {}\n',
      }),
    );
    expect(status).toBe(1);
    expect(output).toContain('./api reaches a command/query/event handler');
  });

  it('reports an unresolvable relative import', () => {
    const { status, output } = check(
      repo({ ...CLEAN, 'domains/orders/src/api/index.ts': "export * from '../missing.js';\n" }),
    );
    expect(status).toBe(1);
    expect(output).toContain(
      "unresolved import '../missing.js' in domains/orders/src/api/index.ts",
    );
  });

  it('fails on a malformed ./api export', () => {
    const bad = manifest();
    bad.exports['./api'] = { ...API_EXPORT, default: './dist/api.js' };
    const { status, output } = check(repo({ ...CLEAN, 'domains/orders/package.json': bad }));
    expect(status).toBe(1);
    expect(output).toContain('@domain/orders: exports["./api"] must be');
  });

  it('fails when the gateway imports a domain root', () => {
    const { status, output } = check(
      repo({
        ...CLEAN,
        'apps/gateway/src/graphql/x.resolver.ts':
          "import { OrdersPort } from '@domain/orders';\nexport const p = OrdersPort;\n",
      }),
    );
    expect(status).toBe(1);
    expect(output).toContain(
      'apps/gateway: apps/gateway/src/graphql/x.resolver.ts imports @domain/orders; use @domain/orders/api',
    );
  });

  it('only flags a missing ./api with --require-all', () => {
    const root = repo({ ...CLEAN, 'domains/orders/package.json': manifest(false) });
    expect(check(root).output).toContain('API subpaths OK (0/1 domains export ./api');
    const strict = check(root, '--require-all');
    expect(strict.status).toBe(1);
    expect(strict.output).toContain('@domain/orders: package.json declares no "./api" export');
  });

  it('passes on this repository with every domain exporting ./api', () => {
    const { status, output } = check(REPO_ROOT, '--require-all');
    // n/n: a domain added later (B2 and on) must export ./api too.
    expect(output).toMatch(/API subpaths OK \((\d+)\/\1 domains export \.\/api/);
    expect(status).toBe(0);
  });
});
