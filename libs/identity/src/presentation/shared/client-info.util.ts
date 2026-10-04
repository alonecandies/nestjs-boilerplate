import { getHeaderValue, type RequestLike } from '@app/common';
import type { ClientInfo } from '@app/contracts';

/**
 * Client fingerprint stored on the session (audit / theft investigation). `req.ip` honours
 * `TRUST_PROXY` (Fastify), so it is the client address, not the load balancer's.
 */
export function clientInfoOf(request: RequestLike | undefined): ClientInfo {
  const client: ClientInfo = {};
  const userAgent = getHeaderValue(request?.headers, 'user-agent');
  if (userAgent !== undefined) client.userAgent = userAgent;
  if (request?.ip !== undefined && request.ip !== '') client.ip = request.ip;
  return client;
}
