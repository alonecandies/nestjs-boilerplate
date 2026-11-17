import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DrizzleInvitationsSystemRepository } from './drizzle-invitations.system-repository.js';
import { DrizzleMembershipsSystemRepository } from './drizzle-memberships.system-repository.js';
import { DrizzleSessionsSystemRepository } from './drizzle-sessions.system-repository.js';
import { DrizzleUsersSystemRepository } from './drizzle-users.system-repository.js';
import { IDENTITY_SYSTEM_METHODS } from './identity.system-methods.js';

const SRC = join(import.meta.dirname, '..', '..');
const TEST_FILE = /\.(?:spec|int-spec|e2e-spec)\.ts$/;
const NAMES_SYSTEM_DATABASE = /\b(?:SystemDatabase|SYSTEM_DATABASE|InjectSystemDatabase)\b/;

/** Every non-test TypeScript source under domains/identity/src (the `testing` fakes included). */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !TEST_FILE.test(entry.name) ? [path] : [];
  });
}

const flat = Object.entries(IDENTITY_SYSTEM_METHODS).flatMap(([, methods]) =>
  Object.values(methods).map((method) => [method.name, method.scope] as const),
);

describe('identity system methods (the doors to the app_system pool)', () => {
  it('pins exactly the plan methods (spec §9: 1-3, 5) and the ruling directory reads', () => {
    expect(flat.toSorted()).toEqual(
      [
        // Plan B3 Task 11 (spec §9).
        ['users.findCredentialsByEmail', 'pre-auth'],
        ['users.existsByEmail', 'pre-auth'],
        ['invitations.findByTokenHash', 'pre-auth'],
        ['sessions.deleteExpired', 'system'],
        // Ruling b3-identity-policies (row-local policies): co-member and cross-tenant reads.
        ['users.findByIdInTenant', 'system'],
        ['users.listInTenant', 'system'],
        // B3 final review F1: the GraphQL users DataLoader (Payment.user) over co-members.
        ['users.findByIdsInTenant', 'system'],
        ['memberships.findMember', 'system'],
        ['memberships.listMembers', 'system'],
        ['memberships.listForUser', 'system'],
      ].toSorted(),
    );
  });

  it('each method is keyed as <repository>.<method> and frozen', () => {
    for (const [repository, methods] of Object.entries(IDENTITY_SYSTEM_METHODS)) {
      for (const [key, method] of Object.entries(methods)) {
        expect(method.name).toBe(`${repository}.${key}`);
        expect(Object.isFrozen(method)).toBe(true);
      }
    }
  });

  it('each Drizzle system repository implements exactly its pinned methods', () => {
    const publicMethods = (prototype: object): string[] =>
      Object.getOwnPropertyNames(prototype)
        .filter((name) => name !== 'constructor')
        .toSorted();
    const repositories = {
      users: DrizzleUsersSystemRepository,
      invitations: DrizzleInvitationsSystemRepository,
      sessions: DrizzleSessionsSystemRepository,
      memberships: DrizzleMembershipsSystemRepository,
    };
    expect(Object.keys(repositories).toSorted()).toEqual(
      Object.keys(IDENTITY_SYSTEM_METHODS).toSorted(),
    );
    for (const [name, repository] of Object.entries(repositories)) {
      const pinned = Object.keys(
        IDENTITY_SYSTEM_METHODS[name as keyof typeof IDENTITY_SYSTEM_METHODS],
      ).toSorted();
      expect(publicMethods(repository.prototype), name).toEqual(pinned);
    }
  });

  it('the *.system-repository.ts files under infrastructure are exactly the four Drizzle ones', () => {
    const files = sources(join(SRC, 'infrastructure'))
      .filter((file) => file.endsWith('.system-repository.ts'))
      .map((file) => relative(SRC, file))
      .toSorted();
    expect(files).toEqual(
      [
        'infrastructure/persistence/drizzle-invitations.system-repository.ts',
        'infrastructure/persistence/drizzle-memberships.system-repository.ts',
        'infrastructure/persistence/drizzle-sessions.system-repository.ts',
        'infrastructure/persistence/drizzle-users.system-repository.ts',
      ].toSorted(),
    );
  });

  it('no other source file of the domain names SystemDatabase', () => {
    expect(NAMES_SYSTEM_DATABASE.test('@InjectSystemDatabase() system: SystemDatabase<S>')).toBe(
      true,
    );
    const naming = sources(SRC)
      .filter((file) => NAMES_SYSTEM_DATABASE.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file))
      .toSorted();
    expect(naming).toEqual(
      [
        'infrastructure/persistence/drizzle-invitations.system-repository.ts',
        'infrastructure/persistence/drizzle-memberships.system-repository.ts',
        'infrastructure/persistence/drizzle-sessions.system-repository.ts',
        'infrastructure/persistence/drizzle-users.system-repository.ts',
      ].toSorted(),
    );
  });
});
