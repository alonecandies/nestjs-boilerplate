import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqualStr } from '@platform/common';
import { register } from 'prom-client';
import { METRICS_PATH } from './metrics.constants.js';

const BEARER_PREFIX = /^Bearer\s+/i;
const TEXT = 'text/plain; charset=utf-8';

export interface MetricsRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly authorization: string | undefined;
}

/** One answer of the metrics listener (also produced in-process by `MetricsListener.scrape()`). */
export interface MetricsScrape {
  readonly status: 200 | 404 | 500;
  readonly contentType: string;
  readonly body: string;
}

export interface MetricsServerOptions {
  /** `METRICS_PORT`; `0` lets the OS pick (tests). */
  readonly port: number;
  /** The app's `HOST` (`0.0.0.0` in containers, so Prometheus reaches it in-network). */
  readonly host: string;
  /** `METRICS_BEARER_TOKEN`: when set, a scrape without `Authorization: Bearer <token>` gets 404. */
  readonly bearerToken?: string | undefined;
  /** The exposition text: this process's registry, or the cluster aggregate in a cluster primary. */
  readonly collect: () => Promise<string>;
}

export interface MetricsServer {
  /** `http://<host>:<port>` actually bound (the OS-picked port when `port` was 0). */
  readonly url: string;
  close(): Promise<void>;
}

/** Disabled endpoint, wrong path or method, missing or wrong token: all look the same. */
export const METRICS_NOT_FOUND: MetricsScrape = {
  status: 404,
  contentType: TEXT,
  body: 'Not Found\n',
};

/**
 * Answers one request of the metrics listener: only `GET` / `HEAD /metrics` (query string ignored);
 * everything else, and a missing or wrong bearer token (constant-time compare), is 404, so the
 * listener reveals nothing. A failing collector answers 500 without its message.
 */
export async function scrapeMetrics(
  options: Pick<MetricsServerOptions, 'bearerToken' | 'collect'>,
  request: MetricsRequest,
): Promise<MetricsScrape> {
  const path = (request.url ?? '').split('?')[0];
  if (path !== METRICS_PATH || (request.method !== 'GET' && request.method !== 'HEAD')) {
    return METRICS_NOT_FOUND;
  }
  if (options.bearerToken !== undefined) {
    const header = request.authorization;
    if (header === undefined || !BEARER_PREFIX.test(header)) return METRICS_NOT_FOUND;
    if (!timingSafeEqualStr(header.replace(BEARER_PREFIX, '').trim(), options.bearerToken)) {
      return METRICS_NOT_FOUND;
    }
  }
  try {
    return { status: 200, contentType: register.contentType, body: await options.collect() };
  } catch {
    return { status: 500, contentType: TEXT, body: 'metrics collection failed\n' };
  }
}

/**
 * Starts the metrics listener: a bare `node:http` server, apart from the API's Fastify instance, so
 * scrapes never touch the API port, its middleware, throttler or logs. Rejects when the port is taken
 * (`EADDRINUSE`): a boot must fail loudly rather than run without metrics.
 */
export function startMetricsServer(options: MetricsServerOptions): Promise<MetricsServer> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void scrapeMetrics(options, {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    }).then((scrape) => {
      response.writeHead(scrape.status, {
        'content-type': scrape.contentType,
        'cache-control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : scrape.body);
    });
  });
  // Scrapes are short: never let a slow client hold a socket.
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      const { port } = server.address() as AddressInfo;
      const host = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;
      resolve({
        url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
