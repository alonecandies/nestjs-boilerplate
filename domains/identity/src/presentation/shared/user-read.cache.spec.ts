import type { User } from '@domain/identity-contracts';
import { EntityNotFoundException, generateId } from '@platform/common';
import type { AppCacheService } from '@platform/redis';
import { describe, expect, it } from 'vitest';
import { makeUser } from '../../../test/fixtures.js';
import { InMemoryAppCache } from '../../../test/in-memory-app-cache.js';
import type { UsersPort } from '../../application/ports/users.port.js';
import { userCacheKey } from '../../identity.constants.js';
import { UserReadCache } from './user-read.cache.js';

/** A `UsersPort` that knows memberships: a scoped read outside the tenant is a 404. */
class FakeUsersPort implements Pick<UsersPort, 'getUser'> {
  readonly calls: Array<{ id: string; scope?: { tenantId: string } }> = [];
  readonly users = new Map<string, User>();
  readonly members = new Map<string, Set<string>>();
  failure: Error | undefined;

  add(user: User, ...tenantIds: string[]): void {
    this.users.set(user.id, user);
    for (const tenantId of tenantIds) this.join(tenantId, user.id);
  }

  join(tenantId: string, userId: string): void {
    const members = this.members.get(tenantId) ?? new Set<string>();
    members.add(userId);
    this.members.set(tenantId, members);
  }

  leave(tenantId: string, userId: string): void {
    this.members.get(tenantId)?.delete(userId);
  }

  async getUser(id: string, scope?: { tenantId: string }): Promise<User> {
    this.calls.push(scope === undefined ? { id } : { id, scope });
    if (this.failure) throw this.failure;
    const user = this.users.get(id);
    const outside = scope !== undefined && !this.members.get(scope.tenantId)?.has(id);
    if (!user || outside) throw new EntityNotFoundException('User', id);
    return user;
  }
}

function setup() {
  const cache = new InMemoryAppCache();
  const port = new FakeUsersPort();
  const reads = new UserReadCache(
    cache as unknown as AppCacheService,
    port as unknown as UsersPort,
  );
  const tenantA = generateId();
  const tenantB = generateId();
  const member = makeUser({ email: 'member@example.com' });
  port.add(member, tenantA);
  return { cache, port, reads, tenantA, tenantB, member };
}

describe('UserReadCache', () => {
  describe('getUser (the caller reads their own profile)', () => {
    it('reads through user:<id> once, then serves it from the cache', async () => {
      const { cache, port, reads, member } = setup();

      await expect(reads.getUser(member.id)).resolves.toMatchObject({ id: member.id });
      await expect(reads.getUser(member.id)).resolves.toMatchObject({ id: member.id });

      expect(port.calls).toEqual([{ id: member.id }]);
      expect([...cache.store.keys()]).toEqual([userCacheKey(member.id)]);
    });

    it('revives the dates of a JSON-cached profile', async () => {
      const { reads, member } = setup();
      await reads.getUser(member.id);

      const cached = await reads.getUser(member.id);
      expect(cached.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('getScopedUser (another user, seen from the caller tenant): never cached', () => {
    it('asks the port with the tenant on every read and writes nothing to the cache', async () => {
      const { cache, port, reads, tenantA, member } = setup();

      await expect(reads.getScopedUser(member.id, { tenantId: tenantA })).resolves.toMatchObject({
        id: member.id,
      });
      await expect(reads.getScopedUser(member.id, { tenantId: tenantA })).resolves.toMatchObject({
        id: member.id,
      });

      expect(port.calls).toEqual([
        { id: member.id, scope: { tenantId: tenantA } },
        { id: member.id, scope: { tenantId: tenantA } },
      ]);
      expect(cache.store.size).toBe(0);
    });

    it('never serves a warm user:<id> to a caller of a tenant the user is not in', async () => {
      const { cache, port, reads, tenantA, tenantB, member } = setup();
      await reads.getUser(member.id); // the member's own read warms user:<id>
      await reads.getScopedUser(member.id, { tenantId: tenantA });
      expect(cache.store.has(userCacheKey(member.id))).toBe(true);

      await expect(reads.getScopedUser(member.id, { tenantId: tenantB })).rejects.toBeInstanceOf(
        EntityNotFoundException,
      );
      await expect(reads.getScopedUser(member.id, { tenantId: tenantB })).rejects.toBeInstanceOf(
        EntityNotFoundException,
      );

      expect(port.calls.slice(-2)).toEqual([
        { id: member.id, scope: { tenantId: tenantB } },
        { id: member.id, scope: { tenantId: tenantB } },
      ]);
      expect([...cache.store.keys()]).toEqual([userCacheKey(member.id)]);
    });

    it('stops serving a removed member at once, with no invalidation call', async () => {
      const { port, reads, tenantA, member } = setup();
      await reads.getScopedUser(member.id, { tenantId: tenantA });

      port.leave(tenantA, member.id);

      await expect(reads.getScopedUser(member.id, { tenantId: tenantA })).rejects.toBeInstanceOf(
        EntityNotFoundException,
      );
    });

    it('propagates a port error other than 404 and caches nothing', async () => {
      const { cache, port, reads, tenantA, member } = setup();
      port.failure = new Error('identity unavailable');

      await expect(reads.getScopedUser(member.id, { tenantId: tenantA })).rejects.toThrow(
        'identity unavailable',
      );
      expect(cache.store.size).toBe(0);
    });
  });

  describe('invalidate', () => {
    it('deletes user:<id>, so the next own read asks the port again', async () => {
      const { port, reads, member } = setup();
      await reads.getUser(member.id);

      await reads.invalidate(member.id);
      await reads.getUser(member.id);

      expect(port.calls).toEqual([{ id: member.id }, { id: member.id }]);
    });

    it('is best effort: a cache outage does not fail the write that called it', async () => {
      const { cache, reads, member } = setup();
      cache.del = () => Promise.reject(new Error('redis down'));

      await expect(reads.invalidate(member.id)).resolves.toBeUndefined();
    });
  });
});
