import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type AbstractHttpAdapter, HttpAdapterHost } from '@nestjs/core';
import { type GraphqlConfig, graphqlConfig } from '@platform/config';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isNil, startsWith } from 'lodash-es';

/**
 * CSP of the embedded Apollo Sandbox landing page (`GET {GRAPHQL_PATH}`, text/html): Apollo's CDN
 * script and inline bootstrap, its iframe, fonts and manifest. Nothing may frame the page itself.
 */
export const SANDBOX_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://embeddable-sandbox.cdn.apollographql.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "frame-src 'self' https://sandbox.embed.apollographql.com",
  "manifest-src 'self' https://apollo-server-landing-page.cdn.apollographql.com",
  "connect-src 'self' https: wss:",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Route-level CSP for the Sandbox, the way `/docs` gets its own: the global helmet CSP stays strict
 * (production: `default-src 'none'`) for the API, and only the HTML landing page served at
 * `GET {GRAPHQL_PATH}` is relaxed, and only while `GRAPHQL_SANDBOX` is on. `onSend` runs after
 * helmet's `onRequest`, so this overrides the global header for that one response.
 */
@Injectable()
export class SandboxCspHook implements OnModuleInit {
  private readonly logger = new Logger(SandboxCspHook.name);

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(graphqlConfig.KEY) private readonly config: GraphqlConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.sandbox) return;
    // null in standalone application contexts (no HTTP server).
    const adapter = this.adapterHost.httpAdapter as AbstractHttpAdapter | null | undefined;
    if (isNil(adapter)) return;
    if (adapter.getType() !== 'fastify') {
      this.logger.warn(`The Sandbox CSP needs the Fastify adapter (got "${adapter.getType()}")`);
      return;
    }
    const path = this.config.path;
    adapter
      .getInstance<FastifyInstance>()
      .addHook(
        'onSend',
        (
          request: FastifyRequest,
          reply: FastifyReply,
          payload: unknown,
          done: (error: null, payload: unknown) => void,
        ): void => {
          const contentType = String(reply.getHeader('content-type') ?? '');
          if (
            request.method === 'GET' &&
            request.routeOptions.url === path &&
            startsWith(contentType, 'text/html')
          ) {
            reply.header('content-security-policy', SANDBOX_CONTENT_SECURITY_POLICY);
          }
          done(null, payload);
        },
      );
  }
}
