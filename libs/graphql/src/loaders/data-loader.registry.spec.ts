import DataLoader from 'dataloader';
import { keyBy } from 'lodash-es';
import { describe, expect, it, vi } from 'vitest';
import { DataLoaderRegistry } from './data-loader.registry.js';

interface User {
  id: string;
  name: string;
}

const DB: Record<string, User> = {
  u1: { id: 'u1', name: 'Ada' },
  u2: { id: 'u2', name: 'Linus' },
};

function usersRegistry() {
  const batch = vi.fn(async (ids: readonly string[]) => {
    const byId = keyBy(
      ids.map((id) => DB[id]).filter((u): u is User => u !== undefined),
      'id',
    );
    return ids.map((id) => byId[id] ?? null);
  });
  const factory = vi.fn(() => new DataLoader<string, User | null>(batch));
  const registry = new DataLoaderRegistry();
  registry.register('users', factory);
  return { registry, batch, factory };
}

describe('DataLoaderRegistry', () => {
  it('batches all loads of one operation into a single call (N+1 → 1)', async () => {
    const { registry, batch } = usersRegistry();
    const loaders = registry.createLoaders();
    const users = loaders['users'] as DataLoader<string, User | null>;

    const result = await Promise.all([users.load('u1'), users.load('u2'), users.load('u1')]);

    expect(result.map((u) => u?.name)).toEqual(['Ada', 'Linus', 'Ada']);
    expect(batch).toHaveBeenCalledOnce();
    expect(batch).toHaveBeenCalledWith(['u1', 'u2']);
  });

  it('isolates operations: separate instances, caches and batches per request', async () => {
    const { registry, batch, factory } = usersRegistry();
    const a = registry.createLoaders();
    const b = registry.createLoaders();

    expect(a['users']).not.toBe(b['users']);
    expect(a['users']).toBe(a['users']); // memoized within the operation

    await a['users']?.load('u1');
    await b['users']?.load('u1');

    // b did not see a's cache: the key was fetched once per operation.
    expect(batch).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('creates loaders lazily: untouched loaders cost nothing', () => {
    const { registry, factory } = usersRegistry();
    const expensive = vi.fn(() => new DataLoader<string, string>(async (keys) => [...keys]));
    registry.register('payments', expensive);

    const loaders = registry.createLoaders();
    void loaders['users'];

    expect(factory).toHaveBeenCalledOnce();
    expect(expensive).not.toHaveBeenCalled();
  });

  it('rejects duplicate names and reports what is registered', () => {
    const { registry } = usersRegistry();

    expect(() =>
      registry.register('users', () => new DataLoader<string, string>(async (k) => [...k])),
    ).toThrow('DataLoader "users" is already registered');
    registry.register('accounts', () => new DataLoader<string, string>(async (k) => [...k]));

    expect(registry.has('users')).toBe(true);
    expect(registry.has('nope')).toBe(false);
    expect(registry.names()).toEqual(['accounts', 'users']);
  });

  it('returns undefined for unknown loaders and exposes registered ones as keys', () => {
    const { registry } = usersRegistry();
    const loaders = registry.createLoaders();

    expect(loaders['unknown']).toBeUndefined();
    expect('users' in loaders).toBe(true);
  });

  it('includes loaders registered after earlier operations started', () => {
    const { registry } = usersRegistry();
    const before = registry.createLoaders();
    registry.register('late', () => new DataLoader<string, string>(async (k) => [...k]));

    expect(before['late']).toBeUndefined();
    expect(registry.createLoaders()['late']).toBeInstanceOf(DataLoader);
  });
});
