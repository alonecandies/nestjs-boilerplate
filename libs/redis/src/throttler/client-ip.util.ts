import type { IncomingMessage } from 'node:http';
import proxyAddr from '@fastify/proxy-addr';

export type ClientIpResolver = (request: IncomingMessage | undefined) => string | undefined;

/**
 * The client IP of a raw Node request (Socket.IO `socket.request`, graphql-ws `ctx.extra.request`)
 * with the SAME trust rules Fastify applies to `req.ip` (`TRUST_PROXY`): `false` → socket
 * address; a list of IPs/CIDRs/presets → the first untrusted hop from the right; `true` → the
 * leftmost `X-Forwarded-For` value (spoofable; rejected in production by the app namespace).
 */
export function createClientIpResolver(trustProxy: boolean | string[]): ClientIpResolver {
  const trust =
    trustProxy === true
      ? (): boolean => true
      : trustProxy === false || trustProxy.length === 0
        ? (): boolean => false
        : proxyAddr.compile(trustProxy);
  return (request) => {
    const socketAddress = request?.socket?.remoteAddress;
    if (request === undefined || socketAddress === undefined) return undefined;
    try {
      return proxyAddr(request, trust);
    } catch {
      return socketAddress;
    }
  };
}
