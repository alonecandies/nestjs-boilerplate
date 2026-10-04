/** Test-only helper (the `.test.ts` suffix keeps it out of the SWC build and the Vitest run). */
import type { ExecutionContext } from '@nestjs/common';

export type Transport = 'http' | 'graphql' | 'ws' | 'rpc';

/**
 * Minimal ExecutionContext for guard tests: `req` is what `getRequest()` resolves for the
 * transport (HTTP request, GraphQL `ctx.req`, or the socket for WS).
 */
export function executionContext(
  type: Transport,
  target: {
    handler: (...args: never[]) => unknown;
    cls: abstract new (...args: never[]) => unknown;
  },
  req: Record<string, unknown> = { headers: {} },
): ExecutionContext {
  const socket = { id: 'sock-1', handshake: { headers: {} }, data: req.data ?? {} };
  const args: unknown[] =
    type === 'graphql' ? [{}, {}, { req }, {}] : type === 'ws' ? [socket, {}] : [req, {}];
  return {
    getType: () => type,
    getHandler: () => target.handler,
    getClass: () => target.cls,
    getArgs: () => args,
    getArgByIndex: (index: number) => args[index],
    switchToHttp: () => ({
      getRequest: () => args[0],
      getResponse: () => args[1],
      getNext: () => undefined,
    }),
    switchToWs: () => ({
      getClient: () => socket,
      getData: () => args[1],
      getPattern: () => 'event',
    }),
    switchToRpc: () => ({ getData: () => ({}), getContext: () => ({}) }),
  } as unknown as ExecutionContext;
}
