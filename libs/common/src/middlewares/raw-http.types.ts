import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * On Fastify, Nest middleware runs through `@fastify/middie` and receives the RAW Node
 * request/response, not FastifyRequest/FastifyReply. Middie copies a few Fastify fields onto the
 * raw request (`id` = Fastify `req.id` from `genReqId`, `originalUrl`, `ip`); Express provides
 * `originalUrl` natively. `url` is mount-relative inside middleware, so prefer `originalUrl`.
 *
 * `id` is re-declared on top of `Omit<IncomingMessage, 'id'>` because pino-http globally augments
 * `http.IncomingMessage` with a REQUIRED `id: ReqId`; extending it directly makes every program that
 * also loads nestjs-pino (observability, bootstrap, apps) fail with TS2430.
 */
export interface RawRequest extends Omit<IncomingMessage, 'id'> {
  id?: string | number;
  originalUrl?: string;
  ip?: string;
}

export type RawResponse = ServerResponse;

export type NextFunction = (error?: unknown) => void;

/** Path without the query string (never put query params — possibly tokens — in problem `instance`). */
export function requestPath(req: Pick<RawRequest, 'originalUrl' | 'url'>): string {
  const url = req.originalUrl ?? req.url ?? '/';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}
