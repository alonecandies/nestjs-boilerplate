/*
 * The request principal reaches the handlers of the real monolith (spec §7): REST and GraphQL over
 * HTTP (JwtAuthGuard writes it in the ClsMiddleware context).
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV);
});

import { UsersPort } from '@domain/identity';
import type { ApplicationConfig } from '@nestjs/core';
import { getPrincipal, type Principal } from '@platform/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, graphql } from './support/http.js';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

describe('principal in CLS (monolith)', () => {
  let e2e: MonolithE2e;
  let tokens: { accessToken: string; tenantId: string; user: { id: string } };
  const seen: (Principal | undefined)[] = [];

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'cls.principal@example.com',
        password: 'correct horse battery staple',
        displayName: 'Cls',
      },
    });
    tokens = res.json();
  });

  // vitest.config.ts sets `restoreMocks: true`: spies installed in beforeAll are gone by the first
  // test, so the probes go in beforeEach.
  beforeEach(() => {
    const ports = e2e.app.get(UsersPort);
    const getUser = ports.getUser.bind(ports);
    vi.spyOn(ports, 'getUser').mockImplementation(
      async (...args: Parameters<UsersPort['getUser']>) => {
        seen.push(getPrincipal());
        return getUser(...args);
      },
    );
    const listUsers = ports.listUsers.bind(ports);
    vi.spyOn(ports, 'listUsers').mockImplementation(
      async (...args: Parameters<UsersPort['listUsers']>) => {
        seen.push(getPrincipal());
        return listUsers(...args);
      },
    );
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('REST: GET /v1/auth/me runs with { userId, tenantId, roles, staff } of the token', async () => {
    seen.length = 0;
    const res = await e2e.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: bearer(tokens.accessToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(seen).toEqual([
      { userId: tokens.user.id, tenantId: tokens.tenantId, roles: ['owner'], staff: false },
    ]);
  });

  it('GraphQL over HTTP: two root fields of one operation see the same principal', async () => {
    seen.length = 0;
    const res = await e2e.app.inject(
      graphql(
        '{ a: users(limit: 1) { items { id } } b: users(limit: 2) { items { id } } }',
        undefined,
        bearer(tokens.accessToken),
      ),
    );
    expect(res.json()).not.toHaveProperty('errors');
    expect(seen).toEqual([
      { userId: tokens.user.id, tenantId: tokens.tenantId, roles: ['owner'], staff: false },
      { userId: tokens.user.id, tenantId: tokens.tenantId, roles: ['owner'], staff: false },
    ]);
  });

  it('Socket.IO / graphql-ws: PrincipalContextInterceptor runs inside the context RequestContextInterceptor opens', () => {
    // Global interceptors nest in registration order (module scan order): ObservabilityModule is
    // imported before AuthModule, so RequestContextInterceptor must come first. Reversed, ws
    // messages and graphql-ws operations would silently run without a principal.
    const config = Reflect.get(e2e.app, 'config') as ApplicationConfig;
    const order = config.getGlobalInterceptors().map((interceptor) => interceptor.constructor.name);
    const outer = order.indexOf('RequestContextInterceptor');
    expect(outer).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('PrincipalContextInterceptor')).toBeGreaterThan(outer);
  });
});
