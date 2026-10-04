/*
 * Gateway e2e: the REAL AppModule (Api modules bound `.forRemote()`, edge infra, global
 * guards/pipes/filter/middleware) behind the production HTTP wiring. The identity and
 * notifications ports are bound to in-memory fake services; billing keeps its real gRPC adapter,
 * pointed at an upstream that is down. See `support/gateway-e2e-app.ts`. Runs without Docker.
 */
await vi.hoisted(async () => {
  const { GATEWAY_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, GATEWAY_E2E_ENV);
});

import { BillingGrpcAdapter, BillingPort } from '@app/billing';
import { HTTP_HEADERS, isUuidV7 } from '@app/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGatewayE2eApp, type GatewayE2e } from './support/gateway-e2e-app.js';
import { bearer, expectProblem, graphql, multipartFile } from './support/http.js';

interface AuthTokensBody {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  user: { id: string; email: string; displayName: string; roles: string[] };
}

const GRACE = {
  email: 'Grace@Example.com',
  password: 'a very long passphrase',
  displayName: 'Grace',
};

describe('gateway (real AppModule, remote ports, fake upstream services)', () => {
  let e2e: GatewayE2e;
  let tokens: AuthTokensBody;

  const inject = (...args: Parameters<GatewayE2e['app']['inject']>) => e2e.app.inject(...args);
  const login = async (): Promise<AuthTokensBody> => {
    const response = await inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: GRACE.email, password: GRACE.password },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<AuthTokensBody>();
  };

  beforeAll(async () => {
    e2e = await createGatewayE2eApp();
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('binds the ports to gRPC adapters (billing is not faked here)', () => {
    expect(e2e.app.get(BillingPort, { strict: false })).toBeInstanceOf(BillingGrpcAdapter);
  });

  describe('ops endpoints', () => {
    it('GET /health/live → 200 without a token', async () => {
      const response = await inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok' });
    });

    it('GET /health/ready only checks Redis (upstream outages must not pull the gateway)', async () => {
      const response = await inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok', info: { redis: { status: 'up' } } });
      expect(Object.keys(response.json<{ details: object }>().details)).toEqual(['redis']);
    });

    it('GET /metrics → Prometheus text with the HTTP latency histogram', async () => {
      await inject({ method: 'GET', url: '/health/live' });
      const response = await inject({ method: 'GET', url: '/metrics' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/plain/);
      expect(response.body).toContain('http_request_duration_seconds_bucket');
    });

    it('GET /openapi.json documents the whole edge API under /v1 (ops routes excluded)', async () => {
      const response = await inject({ method: 'GET', url: '/openapi.json' });
      expect(response.statusCode).toBe(200);
      const paths = Object.keys(response.json<{ paths: Record<string, unknown> }>().paths);
      expect(paths).toEqual(
        expect.arrayContaining([
          '/v1/auth/register',
          '/v1/auth/login',
          '/v1/auth/refresh',
          '/v1/auth/logout',
          '/v1/auth/me',
          '/v1/users',
          '/v1/users/{id}',
          '/v1/users/{id}/roles',
          '/v1/notifications',
          '/v1/notifications/{id}/read',
          '/v1/billing/checkout-sessions',
          '/v1/billing/webhooks/stripe',
          '/v1/billing/payments',
          '/v1/files',
          '/v1/files/presigned-uploads',
          '/v1/files/download-url',
        ]),
      );
      expect(paths.some((path) => path.startsWith('/health') || path === '/metrics')).toBe(false);
    });

    it('GET /openapi.yaml and GET /docs (Scalar HTML with its own CSP)', async () => {
      const yaml = await inject({ method: 'GET', url: '/openapi.yaml' });
      expect(yaml.statusCode).toBe(200);
      expect(yaml.body).toContain('/v1/auth/login');

      const docs = await inject({ method: 'GET', url: '/docs' });
      expect(docs.statusCode).toBe(200);
      expect(docs.headers['content-type']).toMatch(/^text\/html/);
      expect(docs.body).toContain('/openapi.json');
      expect(docs.headers['content-security-policy']).toBeDefined();
    });
  });

  describe('identity through the remote ports', () => {
    it('POST /v1/auth/register → 201 token pair from the identity service', async () => {
      const response = await inject({ method: 'POST', url: '/v1/auth/register', payload: GRACE });
      expect(response.statusCode, response.body).toBe(201);
      tokens = response.json<AuthTokensBody>();
      expect(tokens).toMatchObject({
        tokenType: 'Bearer',
        user: { email: 'grace@example.com', displayName: 'Grace', roles: ['user'] },
      });
      expect(isUuidV7(tokens.user.id)).toBe(true);
      expect(e2e.identity.calls).toContain('AuthService.Register');
    });

    it('POST /v1/auth/register with a taken email → 409 EMAIL_TAKEN (upstream error mapped)', async () => {
      const response = await inject({ method: 'POST', url: '/v1/auth/register', payload: GRACE });
      expectProblem(response, 409, 'EMAIL_TAKEN');
    });

    it('POST /v1/auth/login → 200; a wrong password → 401 INVALID_CREDENTIALS', async () => {
      expect((await login()).user.id).toBe(tokens.user.id);
      const wrong = await inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: GRACE.email, password: 'definitely wrong' },
      });
      expectProblem(wrong, 401, 'INVALID_CREDENTIALS');
    });

    it('GET /v1/auth/me: the token is verified at the edge; the user is read once, then cached', async () => {
      const first = await inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: bearer(tokens.accessToken),
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({
        id: tokens.user.id,
        email: 'grace@example.com',
        roles: ['user'],
      });
      const second = await inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: bearer(tokens.accessToken),
      });
      expect(second.statusCode).toBe(200);
      expect(e2e.identity.calls.filter((call) => call === 'UsersService.GetUser')).toHaveLength(1);
    });

    it('GraphQL { me } with the access token', async () => {
      const response = await inject(
        graphql('{ me { id email displayName roles } }', undefined, bearer(tokens.accessToken)),
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        data: {
          me: {
            id: tokens.user.id,
            email: 'grace@example.com',
            displayName: 'Grace',
            roles: ['USER'],
          },
        },
      });
    });

    it('POST /v1/auth/refresh → a new pair', async () => {
      const response = await inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: tokens.refreshToken },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<AuthTokensBody>().user.id).toBe(tokens.user.id);
    });

    it('POST /v1/auth/logout → 204; the edge denylist then rejects the token (TOKEN_REVOKED)', async () => {
      const session = await login();
      const logout = await inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: bearer(session.accessToken),
        payload: {},
      });
      expect(logout.statusCode, logout.body).toBe(204);
      const me = await inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: bearer(session.accessToken),
      });
      expectProblem(me, 401, 'TOKEN_REVOKED');
    });
  });

  describe('errors are RFC 9457 problem+json', () => {
    it('no token on a protected route → 401 MISSING_TOKEN', async () => {
      const response = await inject({ method: 'GET', url: '/v1/auth/me' });
      expectProblem(response, 401, 'MISSING_TOKEN');
    });

    it('a forged token → 401 INVALID_TOKEN', async () => {
      const forged = tokens.accessToken.replace(/\.[^.]+$/, '.forged-signature');
      const response = await inject({ method: 'GET', url: '/v1/auth/me', headers: bearer(forged) });
      expectProblem(response, 401, 'INVALID_TOKEN');
    });

    it('RBAC: GET /v1/users needs users:read → 403 for a user, 200 once promoted to admin', async () => {
      const denied = await inject({
        method: 'GET',
        url: '/v1/users',
        headers: bearer(tokens.accessToken),
      });
      expectProblem(denied, 403, 'FORBIDDEN');
      expect(e2e.identity.calls).not.toContain('UsersService.ListUsers');

      e2e.identity.setRoles(tokens.user.id, ['admin']);
      const admin = await login();
      const allowed = await inject({
        method: 'GET',
        url: '/v1/users',
        headers: bearer(admin.accessToken),
      });
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(allowed.json()).toMatchObject({ items: [{ id: tokens.user.id }] });
      e2e.identity.setRoles(tokens.user.id, ['user']);
    });

    it('class-validator body validation → 400 with per-field errors (no upstream call)', async () => {
      const before = e2e.identity.calls.length;
      const response = await inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: 'nope', password: '1', displayName: '', role: 'admin' },
      });
      const problem = expectProblem(response, 400);
      const paths = (problem.errors as { path: string }[]).map((issue) => issue.path);
      expect(paths).toEqual(expect.arrayContaining(['email', 'password', 'displayName', 'role']));
      expect(e2e.identity.calls).toHaveLength(before);
    });

    it('zod path-param validation → 400', async () => {
      const response = await inject({
        method: 'POST',
        url: '/v1/notifications/not-a-uuid/read',
        headers: bearer(tokens.accessToken),
      });
      expectProblem(response, 400);
    });
  });

  describe('request ids', () => {
    it('echoes a safe incoming x-request-id (header + problem body)', async () => {
      const response = await inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { [HTTP_HEADERS.REQUEST_ID]: 'gw-e2e:req-7' },
      });
      expect(response.headers[HTTP_HEADERS.REQUEST_ID]).toBe('gw-e2e:req-7');
      expect(expectProblem(response, 401).requestId).toBe('gw-e2e:req-7');
    });

    it('mints a uuidv7 when none (or an unsafe one) is sent', async () => {
      const response = await inject({ method: 'GET', url: '/health/live' });
      expect(isUuidV7(response.headers[HTTP_HEADERS.REQUEST_ID])).toBe(true);
    });
  });

  describe('other contexts', () => {
    it('notifications: list the inbox and mark one read through the remote port', async () => {
      const seeded = e2e.notifications.add({
        userId: tokens.user.id,
        type: 'welcome',
        title: 'Welcome, Grace',
        body: 'Glad to have you.',
        data: {},
      });

      const list = await inject({
        method: 'GET',
        url: '/v1/notifications?limit=10',
        headers: bearer(tokens.accessToken),
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json()).toMatchObject({
        items: [{ id: seeded.id, type: 'welcome', title: 'Welcome, Grace', read: false }],
        nextPageState: null,
      });

      const read = await inject({
        method: 'POST',
        url: `/v1/notifications/${seeded.id}/read`,
        headers: bearer(tokens.accessToken),
      });
      expect(read.statusCode, read.body).toBe(204);
      expect(e2e.notifications.inbox.get(tokens.user.id)?.[0]?.read).toBe(true);

      const missing = await inject({
        method: 'POST',
        url: '/v1/notifications/01900000-0000-7000-8000-000000000000/read',
        headers: bearer(tokens.accessToken),
      });
      expectProblem(missing, 404, 'NOTIFICATION_NOT_FOUND');
    });

    it('billing-service down → 503 problem+json within the gRPC deadline, no internals leaked', async () => {
      const startedAt = performance.now();
      const response = await inject({
        method: 'GET',
        url: '/v1/billing/payments',
        headers: bearer(tokens.accessToken),
      });
      expect(performance.now() - startedAt).toBeLessThan(5_000);
      const problem = expectProblem(response, 503, 'SERVICE_UNAVAILABLE');
      expect(JSON.stringify(problem)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
    });

    it('POST /v1/files streams a multipart upload into the user’s storage prefix', async () => {
      const upload = multipartFile('report.csv', 'text/csv', 'a,b\n1,2\n');
      const response = await inject({
        method: 'POST',
        url: '/v1/files',
        headers: { ...upload.headers, ...bearer(tokens.accessToken) },
        payload: upload.payload,
      });
      expect(response.statusCode, response.body).toBe(201);
      expect(e2e.storage.listKeys(`users/${tokens.user.id}/`)).toEqual([
        expect.stringMatching(/report\.csv$/),
      ]);
    });
  });
});
