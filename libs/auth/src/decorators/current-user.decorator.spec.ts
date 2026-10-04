import { UnauthenticatedException } from '@app/common';
import type { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import { executionContext } from '../guards/execution-context.test.js';
import { makeAuthUser } from '../testing/auth-test.utils.js';
import type { AuthUser } from '../types/auth-user.js';
import { CurrentUser } from './current-user.decorator.js';

type ParamFactory = (data: unknown, context: ExecutionContext) => unknown;

class Controller {
  whole(@CurrentUser() _user: AuthUser): void {
    // handler stub
  }

  field(@CurrentUser('id') _id: string): void {
    // handler stub
  }
}

/** Reads the factory + data Nest stored for the first custom param of `method`. */
function resolveParam(method: keyof Controller, context: ExecutionContext): unknown {
  const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, Controller, method) as Record<
    string,
    { factory: ParamFactory; data: unknown }
  >;
  const [param] = Object.values(metadata);
  if (!param) throw new Error('no param metadata');
  return param.factory(param.data, context);
}

const target = { handler: Controller.prototype.whole, cls: Controller };

describe('@CurrentUser()', () => {
  const user = makeAuthUser();

  it('returns the user or one of its fields, for http, graphql and ws', () => {
    expect(resolveParam('whole', executionContext('http', target, { headers: {}, user }))).toBe(
      user,
    );
    expect(resolveParam('field', executionContext('graphql', target, { headers: {}, user }))).toBe(
      user.id,
    );
    expect(resolveParam('field', executionContext('ws', target, { data: { user } }))).toBe(user.id);
  });

  it('401s when nobody is authenticated', () => {
    expect(() => resolveParam('whole', executionContext('http', target))).toThrow(
      UnauthenticatedException,
    );
    expect(() => resolveParam('whole', executionContext('rpc', target))).toThrow(
      UnauthenticatedException,
    );
  });
});
