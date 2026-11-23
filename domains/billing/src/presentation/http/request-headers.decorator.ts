import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { getHeaderValue, getRequest } from '@platform/common';

const headerOf = (ctx: ExecutionContext, name: string): string | undefined =>
  getHeaderValue(getRequest(ctx)?.headers, name);

/**
 * First value of a request header (`undefined` when absent or empty). Unlike `@Headers(name)`
 * it never yields `string[]` for a repeated header.
 */
export const HeaderValue: (name: string) => ParameterDecorator = createParamDecorator(
  (name: string, ctx: ExecutionContext): string | undefined => headerOf(ctx, name),
);
