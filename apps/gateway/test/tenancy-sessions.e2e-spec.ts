/*
 * Tenancy through the gateway: remote ports over the in-memory fake identity-service (spec §13).
 */
await vi.hoisted(async () => {
  const { GATEWAY_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, GATEWAY_E2E_ENV);
});

import { isUuidV7 } from '@platform/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGatewayE2eApp, type GatewayE2e } from './support/gateway-e2e-app.js';
import { graphql } from './support/http.js';

interface AuthTokensBody {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  tenantRoles: string[];
  user: { id: string };
}
const PASSWORD = 'correct horse battery staple';

describe('tenancy through the gateway (remote ports over the fake identity-service)', () => {
  let e2e: GatewayE2e;
  const inject = (...args: Parameters<GatewayE2e['app']['inject']>) => e2e.app.inject(...args);

  beforeAll(async () => {
    e2e = await createGatewayE2eApp();
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('REST register/refresh carry the tenant; GraphQL AuthPayload exposes tenantId and tenantRoles', async () => {
    const registered = await inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'ada.gw@example.com', password: PASSWORD, displayName: 'Ada' },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const ada = registered.json<AuthTokensBody>();
    expect(isUuidV7(ada.tenantId)).toBe(true);
    expect(ada.tenantRoles).toEqual(['owner']);

    const refreshed = await inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: ada.refreshToken },
    });
    expect(refreshed.json<AuthTokensBody>().tenantId).toBe(ada.tenantId);

    const login = await inject(
      graphql('mutation ($input: LoginInput!) { login(input: $input) { tenantId tenantRoles } }', {
        input: { email: 'ada.gw@example.com', password: PASSWORD },
      }),
    );
    expect(login.json()).toEqual({
      data: { login: { tenantId: ada.tenantId, tenantRoles: ['OWNER'] } },
    });
  });
});
