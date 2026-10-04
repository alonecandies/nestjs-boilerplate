import { pickDefined } from '@app/common';
import { isArray, isPlainObject, isString } from 'lodash-es';
import type { ClsService } from 'nestjs-cls';
import {
  correlationIdFromCls,
  RPC_CLS_KEYS,
  requestIdFromCls,
} from '../context/transport-context.js';
import type { RpcCallerContext } from './grpc-metadata.js';

/**
 * Caller context for an outgoing gRPC call, built from the current nestjs-cls context:
 * - `requestId` = `cls.getId()`. At the edge this is the HTTP request id; inside a service it
 *   is the id adopted by `GrpcContextInterceptor`, so it follows service→service hops.
 * - `correlationId` = the chain's correlation id (see `correlationIdFromCls`).
 * - `userId` and `roles` are copied from the incoming caller when the call is made inside a gRPC
 *   handler.
 * `overrides` wins. The gateway uses it to pass the authenticated `req.user`.
 */
export function callerContextFromCls(
  cls: ClsService | undefined,
  overrides: RpcCallerContext = {},
): RpcCallerContext {
  const context: RpcCallerContext = pickDefined({
    requestId: requestIdFromCls(cls),
    correlationId: correlationIdFromCls(cls),
  });
  if (cls?.isActive()) {
    const caller = cls.get<unknown>(RPC_CLS_KEYS.CALLER);
    if (isPlainObject(caller)) {
      const { userId, roles } = caller as { userId?: unknown; roles?: unknown };
      if (isString(userId)) context.userId = userId;
      if (isArray(roles) && roles.length > 0) context.roles = roles.filter(isString);
    }
    const userId = cls.get<unknown>(RPC_CLS_KEYS.USER_ID);
    if (isString(userId)) context.userId = userId;
  }
  return { ...context, ...pickDefined(overrides) };
}
