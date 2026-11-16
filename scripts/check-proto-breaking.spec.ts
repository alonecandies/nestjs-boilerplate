import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..');
const SCRIPT = join(import.meta.dirname, 'check-proto-breaking.mjs');
const ORDERS_PROTO = 'domains/orders/contracts/src/proto/orders/v1/orders.proto';

const proto = (orderFields: string): string => `syntax = "proto3";

package orders.v1;

service OrdersService {
  rpc GetOrder(GetOrderRequest) returns (Order);
}

message GetOrderRequest {
  string id = 1;
}

message Order {
${orderFields}
}
`;
const BASE_FIELDS = '  string id = 1;\n  string status = 2;';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function git(root: string, ...args: string[]): void {
  const result = spawnSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

/** A git repo whose first commit (tag `base`) holds the shared buf policy and one contracts package. */
function repoWithBase(): string {
  const root = mkdtempSync(join(tmpdir(), 'proto-breaking-'));
  roots.push(root);
  mkdirSync(join(root, 'libs', 'contracts'), { recursive: true });
  copyFileSync(
    join(REPO, 'libs', 'contracts', 'buf.yaml'),
    join(root, 'libs', 'contracts', 'buf.yaml'),
  );
  write(root, ORDERS_PROTO, proto(BASE_FIELDS));
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'tag', 'base');
  return root;
}

function check(root: string, against = 'base'): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--against', against], {
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('check-proto-breaking', () => {
  it('passes when no proto changed', () => {
    const result = check(repoWithBase());
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('ok   domains/orders/contracts');
  });

  it('passes an additive change (new field)', () => {
    const root = repoWithBase();
    write(root, ORDERS_PROTO, proto(`${BASE_FIELDS}\n  string tenant_id = 3;`));
    const result = check(root);
    expect(result.status, result.output).toBe(0);
  });

  it('fails a deleted field and names it', () => {
    const root = repoWithBase();
    write(root, ORDERS_PROTO, proto('  string id = 1;'));
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('Previously present field "2" with name "status"');
    expect(result.output).toContain('FAIL domains/orders/contracts');
  });

  it('skips a contracts package that does not exist at the base ref', () => {
    const root = repoWithBase();
    write(
      root,
      'domains/catalog/contracts/src/proto/catalog/v1/catalog.proto',
      proto(BASE_FIELDS).replaceAll('orders', 'catalog'),
    );
    const result = check(root);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('skip domains/catalog/contracts');
  });

  it('fails clearly on an unknown ref', () => {
    const result = check(repoWithBase(), 'no-such-ref');
    expect(result.status).toBe(1);
    expect(result.output).toContain('unknown git ref no-such-ref');
  });

  it('exits 2 without --against', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(2);
  });
});
