import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { OUTBOX_SYSTEM_METHODS, OutboxSystemRepository } from '@platform/outbox';
import { describe, expect, it } from 'vitest';
import { DrizzleInvitationsSystemRepository } from './drizzle-invitations.system-repository.js';
import { DrizzleMembershipsSystemRepository } from './drizzle-memberships.system-repository.js';
import { IdentityOutboxSystemRepository } from './drizzle-outbox.system-repository.js';
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
  it('pins exactly the plan methods (spec §9: 1-3, 5, 6), the ruling directory reads and the purge', () => {
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
        // Outbox plan Task 5 (spec §9 item 6, ruling 1): the relay's poll, mark and purge.
        // Identity writes no platform rows: no outbox.insertAsPlatform.
        ['outbox.pollUnpublished', 'system'],
        ['outbox.markPublished', 'system'],
        ['outbox.deletePublishedBefore', 'system'],
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

  it('the outbox entries are the shared @platform/outbox methods, never insertAsPlatform', () => {
    expect(IDENTITY_SYSTEM_METHODS.outbox).toEqual({
      pollUnpublished: OUTBOX_SYSTEM_METHODS.poll,
      markPublished: OUTBOX_SYSTEM_METHODS.markPublished,
      deletePublishedBefore: OUTBOX_SYSTEM_METHODS.deletePublishedBefore,
    });
    expect(Object.values(IDENTITY_SYSTEM_METHODS.outbox)).not.toContain(
      OUTBOX_SYSTEM_METHODS.insertAsPlatform,
    );
  });

  it('each Drizzle system repository implements exactly its pinned methods', () => {
    /** Public methods along the prototype chain (a subclass of a shared base inherits them). */
    const publicMethods = (prototype: object | null): string[] => {
      const names = new Set<string>();
      for (let at = prototype; at !== null && at !== Object.prototype; ) {
        for (const name of Object.getOwnPropertyNames(at)) {
          if (name !== 'constructor') names.add(name);
        }
        at = Object.getPrototypeOf(at) as object | null;
      }
      return [...names].toSorted();
    };
    const repositories = {
      users: DrizzleUsersSystemRepository,
      invitations: DrizzleInvitationsSystemRepository,
      sessions: DrizzleSessionsSystemRepository,
      memberships: DrizzleMembershipsSystemRepository,
      outbox: IdentityOutboxSystemRepository,
    };
    expect(Object.keys(repositories).toSorted()).toEqual(
      Object.keys(IDENTITY_SYSTEM_METHODS).toSorted(),
    );
    for (const [name, repository] of Object.entries(repositories)) {
      const pinned = Object.keys(
        IDENTITY_SYSTEM_METHODS[name as keyof typeof IDENTITY_SYSTEM_METHODS],
      ).toSorted();
      // The outbox repository also inherits insertAsPlatform, which identity does not pin and
      // never calls (checked below): its SystemMethod is not in identity's list.
      const inherited = name === 'outbox' ? ['insertAsPlatform'] : [];
      expect(publicMethods(repository.prototype), name).toEqual(
        [...pinned, ...inherited].toSorted(),
      );
    }
    expect(Object.getPrototypeOf(IdentityOutboxSystemRepository.prototype)).toBe(
      OutboxSystemRepository.prototype,
    );
  });

  it('no identity source calls insertAsPlatform or names its system method (no platform-tenant rows)', () => {
    const CALLS = /\.insertAsPlatform\s*\(|OUTBOX_SYSTEM_METHODS\.insertAsPlatform\b/;
    expect(CALLS.test('await repository.insertAsPlatform(records)')).toBe(true);
    expect(CALLS.test('OUTBOX_SYSTEM_METHODS.insertAsPlatform')).toBe(true);
    const calling = sources(SRC)
      .filter((file) => CALLS.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(calling).toEqual([]);
  });

  it('the *.system-repository.ts files under infrastructure are exactly the five Drizzle ones', () => {
    const files = sources(join(SRC, 'infrastructure'))
      .filter((file) => file.endsWith('.system-repository.ts'))
      .map((file) => relative(SRC, file))
      .toSorted();
    expect(files).toEqual(
      [
        'infrastructure/persistence/drizzle-invitations.system-repository.ts',
        'infrastructure/persistence/drizzle-memberships.system-repository.ts',
        'infrastructure/persistence/drizzle-outbox.system-repository.ts',
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
        'infrastructure/persistence/drizzle-outbox.system-repository.ts',
        'infrastructure/persistence/drizzle-sessions.system-repository.ts',
        'infrastructure/persistence/drizzle-users.system-repository.ts',
      ].toSorted(),
    );
  });
});
