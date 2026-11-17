import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ELEVATION_REASONS } from '@platform/database';
import { describe, expect, it } from 'vitest';
import { IDENTITY_RBAC, IdentityPermission } from '../../identity.permissions.js';

const SRC = join(import.meta.dirname, '..', '..');
const TEST_FILE = /\.(?:spec|int-spec|e2e-spec)\.ts$/;
/** Whole-line comments are not code (the boundary script strips them the same way). */
const LINE_COMMENT = /^\s*(?:\/\/|\*|\/\*).*$/gm;

/** Every non-test TypeScript source under domains/identity/src, as a src-relative path. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !TEST_FILE.test(entry.name) ? [path] : [];
  });
}

const code = (path: string): string => readFileSync(path, 'utf8').replace(LINE_COMMENT, '');
const rel = (path: string): string => relative(SRC, path).split('\\').join('/');
const ALL = sources(SRC).filter((path) => !rel(path).startsWith('testing/'));

/** The one reason each justified-elevation service may use (spec §9, plan B3 Task 12). */
const ELEVATED_SERVICES: Record<string, (typeof ELEVATION_REASONS)[number]> = {
  'application/services/tenant-bootstrap.elevated.ts': 'tenant-bootstrap',
  'application/services/invitation-acceptance.elevated.ts': 'verified-invitation',
  'application/services/membership-activity.elevated.ts': 'membership-activity',
};

/** The permission-gated use cases: each elevates with the permission its route requires. */
const ELEVATING_HANDLERS: Record<string, IdentityPermission> = {
  'application/commands/create-invitation/create-invitation.handler.ts':
    IdentityPermission.MembersManage,
  'application/commands/update-member-roles/update-member-roles.handler.ts':
    IdentityPermission.MembersManage,
  'application/commands/remove-member/remove-member.handler.ts': IdentityPermission.MembersManage,
  'application/commands/rename-tenant/rename-tenant.handler.ts': IdentityPermission.TenantManage,
};

const JUSTIFIED_CALL = /\.justified\(\s*'([^']*)'/g;
const ELEVATE_CALL = /\.elevate\(\s*([^)]*?)\s*\)/g;

describe('identity RLS elevation (B3 Task 12)', () => {
  it('the *.elevated.ts files are exactly the three justified services', () => {
    const elevated = ALL.map(rel).filter((path) => path.endsWith('.elevated.ts'));
    expect(elevated.toSorted()).toEqual(Object.keys(ELEVATED_SERVICES).toSorted());
  });

  it.each(Object.entries(ELEVATED_SERVICES))('%s uses exactly its own reason', (path, reason) => {
    const source = code(join(SRC, path));
    const reasons = [...source.matchAll(JUSTIFIED_CALL)].map(([, used]) => used);
    expect(reasons.length).toBeGreaterThan(0);
    expect(new Set(reasons)).toEqual(new Set([reason]));
    expect(ELEVATION_REASONS).toContain(reason);
    // No permission elevation hides in a justified service.
    expect(source).not.toMatch(/\.elevate\(/);
  });

  it('every elevate() call passes a permission of IDENTITY_RBAC, written as IdentityPermission.X', () => {
    const calls = ALL.flatMap((path) =>
      [...code(path).matchAll(ELEVATE_CALL)].map(([, argument]) => ({
        file: rel(path),
        argument: argument ?? '',
      })),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const { file, argument } of calls) {
      const match = /^IdentityPermission\.(\w+)$/.exec(argument);
      expect(match, `${file}: elevate(${argument})`).not.toBeNull();
      const permission = IdentityPermission[match?.[1] as keyof typeof IdentityPermission];
      expect(IDENTITY_RBAC.permissions, `${file}: elevate(${argument})`).toContain(permission);
    }
    // Every elevating file is a command handler, and the gated ones each use their route's permission.
    const byFile = new Map<string, Set<string>>();
    for (const { file, argument } of calls) {
      const permission =
        IdentityPermission[argument.split('.')[1] as keyof typeof IdentityPermission];
      byFile.set(file, (byFile.get(file) ?? new Set()).add(permission));
    }
    expect(Object.fromEntries([...byFile].map(([file, set]) => [file, [...set]]))).toEqual(
      Object.fromEntries(
        Object.entries(ELEVATING_HANDLERS).map(([file, permission]) => [file, [permission]]),
      ),
    );
  });

  it('elevate() comes first in the unit of work of each gated handler', () => {
    for (const path of Object.keys(ELEVATING_HANDLERS)) {
      const source = code(join(SRC, path));
      const work = source.indexOf('this.transactions.run(async () => {');
      expect(work, path).toBeGreaterThan(-1);
      const firstAwait = source.indexOf('await ', work);
      expect(source.slice(firstAwait, firstAwait + 30), path).toMatch(
        /^await this\.elevation\.elevate\(/,
      );
    }
  });
});
