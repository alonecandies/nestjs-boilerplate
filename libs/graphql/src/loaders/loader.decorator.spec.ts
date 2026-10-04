import type { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import DataLoader from 'dataloader';
import { describe, expect, it } from 'vitest';
import type { GqlContext } from '../context/gql-context.js';
import { DataLoaderRegistry } from './data-loader.registry.js';
import { Loader, resolveLoader } from './loader.decorator.js';

function graphqlExecutionContext(context: GqlContext): ExecutionContext {
  const host = new ExecutionContextHost([{}, {}, context, {}]);
  host.setType('graphql');
  return host;
}

function contextWithLoaders(): GqlContext {
  const registry = new DataLoaderRegistry();
  registry.register('users', () => new DataLoader<string, string>(async (keys) => [...keys]));
  return { req: { headers: {} }, loaders: registry.createLoaders() };
}

describe('resolveLoader', () => {
  it("returns the operation's loader", () => {
    const ctx = contextWithLoaders();

    expect(resolveLoader(graphqlExecutionContext(ctx), 'users')).toBe(ctx.loaders['users']);
  });

  it('throws a descriptive error for unregistered loaders', () => {
    expect(() => resolveLoader(graphqlExecutionContext(contextWithLoaders()), 'payments')).toThrow(
      'DataLoader "payments" is not registered',
    );
  });
});

describe('@Loader', () => {
  it('registers a custom param decorator carrying the loader name', () => {
    class Resolver {
      user(@Loader('users') _users: unknown): void {
        // Only the parameter metadata matters here.
      }
    }

    const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, Resolver, 'user') as Record<
      string,
      { index: number; data: unknown; factory: (data: unknown, ctx: ExecutionContext) => unknown }
    >;
    const [entry] = Object.values(metadata);
    const ctx = contextWithLoaders();

    expect(entry).toMatchObject({ index: 0, data: 'users' });
    expect(entry?.factory('users', graphqlExecutionContext(ctx))).toBe(ctx.loaders['users']);
  });
});
