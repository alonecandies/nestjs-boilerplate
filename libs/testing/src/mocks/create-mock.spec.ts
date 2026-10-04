import { Inject, Injectable, Module } from '@nestjs/common';
import { MetadataScanner } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, expectTypeOf, it, type Mock, vi } from 'vitest';
import { createMock, type Mocked } from './create-mock.js';

interface User {
  id: string;
  name: string;
}

abstract class UsersPort {
  abstract readonly source: 'local' | 'grpc';
  abstract getUser(id: string): Promise<User>;
  abstract listIds(limit: number): string[];
}

describe('createMock', () => {
  it('auto-creates cached vi.fn() members on access', () => {
    const users = createMock<UsersPort>();
    expect(vi.isMockFunction(users.getUser)).toBe(true);
    expect(users.getUser).toBe(users.getUser);
    users.listIds.mockReturnValue(['a']);
    expect(users.listIds(10)).toEqual(['a']);
    expect(users.listIds).toHaveBeenCalledWith(10);
  });

  it('wraps function overrides in spies and keeps value overrides as-is', async () => {
    const users = createMock<UsersPort>({
      source: 'grpc',
      getUser: async (id: string) => ({ id, name: 'Ada' }),
    });
    await expect(users.getUser('u1')).resolves.toEqual({ id: 'u1', name: 'Ada' });
    expect(users.getUser).toHaveBeenCalledWith('u1');
    expect(users.source).toBe('grpc');
  });

  it('keeps an existing mock override untouched', () => {
    const getUser = vi.fn();
    expect(createMock<UsersPort>({ getUser }).getUser).toBe(getUser);
  });

  it('is not thenable, so it can be awaited or returned from async factories', async () => {
    const users = createMock<UsersPort>();
    expect((users as unknown as { then?: unknown }).then).toBeUndefined();
    await expect(Promise.resolve(users)).resolves.toBe(users);
    expect(String(Object.prototype.toString.call(users))).toBe('[object Object]');
  });

  it('survives reflection-based explorers (GraphQL resolvers, CQRS, schedule)', () => {
    const users = createMock<UsersPort>();
    // What @nestjs/graphql's ResolversExplorerService does with every provider instance.
    expect(new MetadataScanner().getAllMethodNames(Object.getPrototypeOf(users))).toEqual([]);
    expect(typeof users.constructor).toBe('function');
    expect(() => Reflect.getMetadata('graphql:resolver_type', users.constructor)).not.toThrow();
    expect(Reflect.getMetadata('graphql:resolver_type', users.constructor)).toBeUndefined();
  });

  it('supports assignment, `in` and deletion', () => {
    const users = createMock<UsersPort>();
    const replacement = vi.fn();
    (users as { getUser: unknown }).getUser = replacement;
    expect(users.getUser).toBe(replacement);
    expect('getUser' in users).toBe(true);
    expect('listIds' in users).toBe(false);
    delete (users as Partial<Mocked<UsersPort>>).getUser;
    expect('getUser' in users).toBe(false);
  });

  it('types methods as vitest mocks with the original signature', () => {
    const users = createMock<UsersPort>();
    expectTypeOf(users.getUser).toEqualTypeOf<Mock<(id: string) => Promise<User>>>();
    expectTypeOf(users.source).toEqualTypeOf<'local' | 'grpc'>();
  });

  it('works as a Nest provider value and as an auto mocker', async () => {
    @Injectable()
    class Greeter {
      constructor(@Inject(UsersPort) private readonly users: UsersPort) {}
      async greet(id: string): Promise<string> {
        return `Hello, ${(await this.users.getUser(id)).name}`;
      }
    }
    @Module({ providers: [Greeter] })
    class GreeterModule {}

    const moduleRef = await Test.createTestingModule({ imports: [GreeterModule] })
      .useMocker((token) =>
        token === UsersPort
          ? createMock<UsersPort>({ getUser: async () => ({ id: '1', name: 'Grace' }) })
          : undefined,
      )
      .compile();
    await moduleRef.init();
    await expect(moduleRef.get(Greeter).greet('1')).resolves.toBe('Hello, Grace');
    await moduleRef.close();
  });
});
