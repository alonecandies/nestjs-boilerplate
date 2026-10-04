import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type DataLoader from 'dataloader';
import { getGqlContext } from '../context/gql-context.js';

/**
 * Resolves the operation's DataLoader registered under `name`. A missing loader is a wiring bug,
 * so this throws a plain `Error` (surfaced as an internal error) instead of returning `undefined`
 * and failing later.
 */
export function resolveLoader(ctx: ExecutionContext, name: string): DataLoader<unknown, unknown> {
  const loader = getGqlContext(ctx).loaders[name];
  if (loader === undefined) {
    throw new Error(`DataLoader "${name}" is not registered (DataLoaderRegistry.register)`);
  }
  return loader;
}

// Created once at module load: createParamDecorator returns a decorator factory.
const LoaderParam = createParamDecorator((name: string, ctx: ExecutionContext) =>
  resolveLoader(ctx, name),
);

/**
 * Injects this operation's DataLoader into a resolver method:
 * ```ts
 * @ResolveField(() => UserModel, { complexity: 5 })
 * user(@Parent() p: PaymentModel, @Loader('users') users: DataLoader<string, User | null>) {
 *   return users.load(p.userId);
 * }
 * ```
 */
export const Loader = (name: string): ParameterDecorator => LoaderParam(name);
