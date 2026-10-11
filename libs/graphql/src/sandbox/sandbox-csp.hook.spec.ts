import helmet from '@fastify/helmet';
import type { HttpAdapterHost } from '@nestjs/core';
import type { GraphqlConfig } from '@platform/config';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SANDBOX_CONTENT_SECURITY_POLICY, SandboxCspHook } from './sandbox-csp.hook.js';

/** The production global CSP (libs/bootstrap security.ts): nothing may load, nothing may frame. */
const STRICT = { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } };

describe('SandboxCspHook', () => {
  let app: FastifyInstance;

  async function appWith(sandbox: boolean): Promise<FastifyInstance> {
    app = fastify();
    await app.register(helmet, { contentSecurityPolicy: STRICT });
    const adapter = { getType: () => 'fastify', getInstance: () => app };
    new SandboxCspHook(
      { httpAdapter: adapter } as unknown as HttpAdapterHost,
      { sandbox, path: '/graphql' } as GraphqlConfig,
    ).onModuleInit();
    app.get('/graphql', async (_request, reply) => reply.type('text/html').send('<html></html>'));
    app.post('/graphql', async () => ({ data: {} }));
    app.get('/v1/users', async () => []);
    await app.ready();
    return app;
  }

  afterEach(async () => {
    await app.close();
  });

  it('gives the Sandbox landing page its own CSP, leaving the API strict', async () => {
    await appWith(true);
    const page = await app.inject({ method: 'GET', url: '/graphql' });
    expect(page.headers['content-security-policy']).toBe(SANDBOX_CONTENT_SECURITY_POLICY);
    expect(SANDBOX_CONTENT_SECURITY_POLICY).toContain(
      'https://embeddable-sandbox.cdn.apollographql.com',
    );
    expect(SANDBOX_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");

    const operation = await app.inject({ method: 'POST', url: '/graphql', payload: {} });
    const rest = await app.inject({ method: 'GET', url: '/v1/users' });
    for (const response of [operation, rest]) {
      expect(response.headers['content-security-policy']).toContain("default-src 'none'");
      expect(response.headers['content-security-policy']).not.toContain('apollographql');
    }
  });

  it('installs nothing while the Sandbox is off', async () => {
    await appWith(false);
    const page = await app.inject({ method: 'GET', url: '/graphql' });
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
  });
});
