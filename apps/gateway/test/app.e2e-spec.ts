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

import {
  BILLING_LOG_REDACT_PATHS,
  BillingGrpcAdapter,
  BillingPort,
  LedgerPostingConsumer,
  stripeConfig,
} from '@domain/billing';
import { passwordConfig, refreshTokenConfig } from '@domain/identity';
import { ConfigService } from '@nestjs/config';
import { DomainValidationException, generateId, HTTP_HEADERS, isUuidV7 } from '@platform/common';
import { ImmudbClient } from '@platform/immudb';
import { MetricsListener } from '@platform/observability';
import { outboxRelayToken } from '@platform/outbox';
import { PARAMS_PROVIDER_TOKEN, type Params } from 'nestjs-pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGatewayE2eApp, type GatewayE2e } from './support/gateway-e2e-app.js';
import { bearer, expectProblem, graphql, multipartFile } from './support/http.js';

interface AuthTokensBody {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  user: { id: string; email: string; displayName: string };
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

  it('never loads the refreshToken, password or stripe namespaces (least privilege: no issuing secrets at the edge)', () => {
    const config = e2e.app.get(ConfigService);
    for (const namespace of [refreshTokenConfig, passwordConfig, stripeConfig]) {
      expect(config.get(namespace.namespace), namespace.namespace).toBeUndefined();
      expect(() => e2e.app.get(namespace.KEY, { strict: false }), namespace.namespace).toThrow();
    }
  });

  it('runs no outbox relay: the edge owns no outbox (identity and billing relay in their services)', () => {
    for (const outbox of ['identity', 'billing']) {
      expect(() => e2e.app.get(outboxRelayToken(outbox), { strict: false }), outbox).toThrow();
    }
  });

  it('loads no ledger: neither an immudb client nor the ledger-posting consumer (billing owns both)', () => {
    expect(() => e2e.app.get(ImmudbClient, { strict: false })).toThrow();
    expect(() => e2e.app.get(LedgerPostingConsumer, { strict: false })).toThrow();
  });

  it('composes billing’s log redaction paths into the logger (the Stripe-Signature header is never logged)', () => {
    const { pinoHttp } = e2e.app.get<Params>(PARAMS_PROVIDER_TOKEN);
    expect(pinoHttp).toMatchObject({
      redact: { paths: expect.arrayContaining([...BILLING_LOG_REDACT_PATHS]) },
    });
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

    it('GET /metrics is not served on the API port (METRICS_PORT has its own listener)', async () => {
      expect((await inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    });

    it('the metrics listener answers with Prometheus text and the HTTP latency histogram', async () => {
      await inject({ method: 'GET', url: '/health/live' });
      const scrape = await e2e.app.get(MetricsListener, { strict: false }).scrape();
      expect(scrape.status).toBe(200);
      expect(scrape.contentType).toMatch(/^text\/plain/);
      expect(scrape.body).toContain('# TYPE http_request_duration_seconds histogram');
      expect(scrape.body).toContain('process_cpu_user_seconds_total');
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
        user: { email: 'grace@example.com', displayName: 'Grace' },
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
        graphql('{ me { id email displayName } }', undefined, bearer(tokens.accessToken)),
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        data: {
          me: {
            id: tokens.user.id,
            email: 'grace@example.com',
            displayName: 'Grace',
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

    it('RBAC: GET /v1/users needs users:read → 403 for a workspace member, 200 for its admin', async () => {
      const registered = await inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'member.rbac@example.com',
          password: GRACE.password,
          displayName: 'Member',
        },
      });
      const body = registered.json<AuthTokensBody & { tenantId: string }>();
      const loginAs = async () =>
        (
          await inject({
            method: 'POST',
            url: '/v1/auth/login',
            payload: { email: 'member.rbac@example.com', password: GRACE.password },
          })
        ).json<AuthTokensBody>().accessToken;

      e2e.identity.setMembershipRoles(body.tenantId, body.user.id, ['member']);
      const denied = await inject({
        method: 'GET',
        url: '/v1/users',
        headers: bearer(await loginAs()),
      });
      expectProblem(denied, 403, 'FORBIDDEN');
      expect(e2e.identity.calls).not.toContain('UsersService.ListUsers');

      e2e.identity.setMembershipRoles(body.tenantId, body.user.id, ['admin']);
      const allowed = await inject({
        method: 'GET',
        url: '/v1/users',
        headers: bearer(await loginAs()),
      });
      expect(allowed.statusCode, allowed.body).toBe(200);
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
      // The inbox is the token's (tenant, user) pair (B4-1); the same user's inbox in another
      // tenant is never listed.
      const [, claims = ''] = tokens.accessToken.split('.');
      const { tid } = JSON.parse(Buffer.from(claims, 'base64url').toString()) as { tid: string };
      e2e.notifications.add({
        tenantId: generateId(),
        userId: tokens.user.id,
        type: 'system',
        title: 'Elsewhere',
        body: 'In another workspace.',
        data: {},
      });
      const seeded = e2e.notifications.add({
        tenantId: tid,
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
      expect(e2e.notifications.inbox.get(`${tid}/${tokens.user.id}`)?.[0]?.read).toBe(true);

      const missing = await inject({
        method: 'POST',
        url: '/v1/notifications/01900000-0000-7000-8000-000000000000/read',
        headers: bearer(tokens.accessToken),
      });
      expectProblem(missing, 404, 'NOTIFICATION_NOT_FOUND');
    });

    it('billing-service down → 503 problem+json within the gRPC deadline, no internals leaked', async () => {
      // No stopwatch: the client deadline (GRPC_DEADLINE_MS) bounds the call, the e2e project's
      // test timeout bounds the test, and a deadline expiry would answer 504, not this 503.
      const response = await inject({
        method: 'GET',
        url: '/v1/billing/payments',
        headers: bearer(tokens.accessToken),
      });
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
      // Keys live under the token's active tenant (B4-3): tenants/<tid>/users/<uid>/.
      const [, claims = ''] = tokens.accessToken.split('.');
      const { tid } = JSON.parse(Buffer.from(claims, 'base64url').toString()) as { tid: string };
      expect(e2e.storage.listKeys(`tenants/${tid}/users/${tokens.user.id}/`)).toEqual([
        expect.stringMatching(/report\.csv$/),
      ]);
    });
  });
});

/*
 * The Stripe webhook through the gateway (outbox plan Task 19): the edge forwards the exact bytes and
 * the signature to billing-service and answers with what it answered. It owns no outbox, no ledger
 * and no Stripe key: the posting record of a money event is written by billing-service (its own e2e
 * pins that), so the edge's answer is the same with the ledger on or off.
 */
describe('gateway: the Stripe webhook is forwarded to billing-service unchanged', () => {
  const handleStripeWebhook = vi.fn();
  const billing = { createCheckoutSession: vi.fn(), handleStripeWebhook, listPayments: vi.fn() };
  let e2e: GatewayE2e;

  const body = JSON.stringify({
    id: 'evt_gateway_e2e',
    object: 'event',
    type: 'charge.succeeded',
    data: { object: { id: 'ch_gateway_e2e', object: 'charge' } },
  });
  const post = (signature?: string) =>
    e2e.app.inject({
      method: 'POST',
      url: '/v1/billing/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        ...(signature === undefined ? {} : { 'stripe-signature': signature }),
      },
      payload: body,
    });

  beforeAll(async () => {
    e2e = await createGatewayE2eApp({ billing: billing as unknown as BillingPort });
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('answers 200 without a token with billing-service’s answer, after handing it the raw bytes and the signature', async () => {
    handleStripeWebhook.mockResolvedValueOnce({
      received: true,
      eventId: 'evt_gateway_e2e',
      eventType: 'charge.succeeded',
      duplicate: false,
    });

    const response = await post('t=1,v1=signature');

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      received: true,
      eventId: 'evt_gateway_e2e',
      eventType: 'charge.succeeded',
      duplicate: false,
    });
    expect(handleStripeWebhook).toHaveBeenCalledOnce();
    const [forwarded] = handleStripeWebhook.mock.calls[0] as [
      { payload: Buffer; signature: string },
    ];
    expect(forwarded.signature).toBe('t=1,v1=signature');
    expect(Buffer.isBuffer(forwarded.payload) && forwarded.payload.toString('utf8')).toBe(body);
  });

  it('a redelivery is acknowledged as billing-service says (duplicate: true)', async () => {
    handleStripeWebhook.mockResolvedValueOnce({
      received: true,
      eventId: 'evt_gateway_e2e',
      eventType: 'charge.succeeded',
      duplicate: true,
    });

    const response = await post('t=1,v1=signature');

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ duplicate: true });
  });

  it('billing-service refusing the signature is the answer: 422, not retried or rewritten', async () => {
    handleStripeWebhook.mockRejectedValueOnce(
      new DomainValidationException('Invalid webhook signature', {
        code: 'INVALID_WEBHOOK_SIGNATURE',
      }),
    );

    expectProblem(await post('t=1,v1=forged'), 422, 'INVALID_WEBHOOK_SIGNATURE');
  });
});
