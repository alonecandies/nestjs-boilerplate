/*
 * Maintenance mode over the WebSocket transports (monolith, ARCH-2): with `MAINTENANCE_MODE=true`
 * a graphql-ws connection is refused, a Socket.IO handshake gets `connect_error` carrying the 503
 * problem, and the probes still answer. The sockets carry a VALID access token: only the switch
 * can be the reason they are refused. The rest of the REST surface is covered by the middleware
 * spec in `@platform/common`.
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV, {
    MAINTENANCE_MODE: 'true',
    // The per-IP handshake cap stays out of the way.
    THROTTLE_WS_HANDSHAKE_LIMIT: '100000',
    THROTTLE_WS_SOCKETS_PER_USER: '1000',
  });
});

import { refreshTokenConfig } from '@domain/identity';
import { TokenIssuer } from '@domain/identity/testing';
import { JwtService } from '@nestjs/jwt';
import { generateId } from '@platform/common';
import { authConfig } from '@platform/config';
import {
  GraphqlWsClients,
  listenOnLoopback,
  refused,
  SocketClients,
} from '@platform/testing/realtime';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

describe('maintenance mode on the WebSocket transports (monolith, ARCH-2)', () => {
  let e2e: MonolithE2e;
  let wsUrl = '';
  let token = '';
  const sockets = new SocketClients('/notifications');
  const graphqlWs = new GraphqlWsClients();

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
    ({ wsUrl } = await listenOnLoopback(e2e.app));
    const issuer = new TokenIssuer(
      new JwtService(),
      authConfig.parse(),
      refreshTokenConfig.parse(),
    );
    ({ token } = await issuer.issueAccessToken({
      id: generateId(),
      email: 'maintenance@example.com',
      tenantId: generateId(),
      roles: ['member'],
    }));
  });

  afterAll(async () => {
    sockets.closeAll();
    await graphqlWs.disposeAll();
    await e2e?.app.close();
  });

  it('refuses a graphql-ws connection that carries a valid token', async () => {
    const connection = graphqlWs.open(wsUrl, {
      connectionParams: { authorization: `Bearer ${token}` },
    });

    await expect(connection.acknowledgement()).rejects.toThrow(/closed before the acknowledgement/);
    expect(connection.open).toBe(false);
  });

  it('fails a Socket.IO handshake with connect_error carrying status 503', async () => {
    const refusal = await refused(sockets.open(wsUrl, { token }));

    expect(refusal.data).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
  });

  it('keeps /health/live answering', async () => {
    const response = await e2e.app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
  });

  it('still answers REST with 503, so the switch is on for every transport', async () => {
    const response = await e2e.app.inject({ method: 'GET', url: '/v1/notifications' });

    expect(response.statusCode).toBe(503);
  });
});
