/*
 * Monolith e2e: the REAL AppModule (every Core module, Api modules bound `.forLocal()`, global
 * guards/pipes/filter/middleware) behind the production HTTP wiring, with fakes only where a
 * connection would be opened (see `support/monolith-e2e-app.ts`). Runs without Docker.
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV);
});

import { BillingLocalAdapter, BillingPort } from '@app/billing';
import { HTTP_HEADERS, isUuidV7 } from '@app/common';
import { KAFKA_TOPICS } from '@app/contracts';
import { NotificationsLocalAdapter, NotificationsPort } from '@app/notifications';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, expectProblem, graphql, multipartFile } from './support/http.js';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

interface AuthTokensBody {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  user: { id: string; email: string; displayName: string; roles: string[] };
}

const ADA = {
  email: 'Ada@Example.com',
  password: 'correct horse battery staple',
  displayName: 'Ada',
};

describe('monolith (real AppModule, local adapters, fakes at the network edges)', () => {
  let e2e: MonolithE2e;
  let tokens: AuthTokensBody;

  const inject = (...args: Parameters<MonolithE2e['app']['inject']>) => e2e.app.inject(...args);

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
  });

  afterAll(async () => {
    await e2e?.app.close();
    // Shutdown hooks of the data modules ran against the fakes (pool end, Cassandra shutdown).
    expect(e2e.postgres.state.ended).toBe(true);
    expect(e2e.cassandra.state.shutdown).toBe(true);
  });

  it('binds every port to its LOCAL adapter (CommandBus/QueryBus, no gRPC)', () => {
    expect(e2e.app.get(BillingPort, { strict: false })).toBeInstanceOf(BillingLocalAdapter);
    expect(e2e.app.get(NotificationsPort, { strict: false })).toBeInstanceOf(
      NotificationsLocalAdapter,
    );
  });

  describe('ops endpoints', () => {
    it('GET /health/live → 200 without a token', async () => {
      const response = await inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok' });
    });

    it('GET /health/ready → 200 on postgres, cassandra and redis: an unreachable Kafka never un-readies the API', async () => {
      // KAFKA_BROKERS points at a closed port: event publishing is best-effort, so the REST/GraphQL
      // API must stay in rotation during a broker outage.
      const response = await inject({ method: 'GET', url: '/health/ready' });
      const body = response.json<{ status: string; info: object; error: object }>();
      expect(response.statusCode).toBe(200);
      expect(body.status).toBe('ok');
      expect(Object.keys({ ...body.info, ...body.error }).sort()).toEqual([
        'cassandra',
        'postgres',
        'redis',
      ]);
      expect(body.info).toMatchObject({
        postgres: { status: 'up' },
        cassandra: { status: 'up' },
        redis: { status: 'up' },
      });
      expect(body.error).toEqual({});
    });

    it('GET /metrics → Prometheus text with the HTTP latency histogram', async () => {
      await inject({ method: 'GET', url: '/health/live' });
      const response = await inject({ method: 'GET', url: '/metrics' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/plain/);
      expect(response.body).toContain('http_request_duration_seconds_bucket');
      expect(response.body).toContain('process_cpu_user_seconds_total');
    });

    it('GET /openapi.json documents every bounded context under /v1 (ops routes excluded)', async () => {
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
          '/v1/billing/checkout-sessions',
          '/v1/billing/webhooks/stripe',
          '/v1/billing/payments',
          '/v1/files',
          '/v1/files/presigned-uploads',
        ]),
      );
      expect(paths.some((path) => path.startsWith('/health') || path === '/metrics')).toBe(false);
    });

    it('GET /docs → the Scalar API reference (HTML with its own CSP)', async () => {
      const response = await inject({ method: 'GET', url: '/docs' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/html/);
      expect(response.body).toContain('/openapi.json');
      expect(response.headers['content-security-policy']).toBeDefined();
    });
  });

  describe('identity through the local adapters (real handlers, argon2, JWT)', () => {
    it('POST /v1/auth/register → 201 token pair; the relay publishes identity.user-registered.v1', async () => {
      const response = await inject({ method: 'POST', url: '/v1/auth/register', payload: ADA });
      expect(response.statusCode, response.body).toBe(201);
      tokens = response.json<AuthTokensBody>();
      expect(tokens).toMatchObject({
        tokenType: 'Bearer',
        expiresIn: 900,
        user: { email: 'ada@example.com', displayName: 'Ada', roles: ['user'] },
      });
      expect(isUuidV7(tokens.user.id)).toBe(true);
      // Persisted through the (in-memory) repository: normalised email, argon2id hash.
      const stored = e2e.identity.store.users.get(tokens.user.id);
      expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);

      // UserRegisteredEvent → UserRegisteredRelay → Kafka, after the handler committed.
      await vi.waitFor(() =>
        expect(e2e.kafka.envelopes(KAFKA_TOPICS.USER_REGISTERED)).toHaveLength(1),
      );
      expect(e2e.kafka.envelopes(KAFKA_TOPICS.USER_REGISTERED)[0]).toMatchObject({
        type: KAFKA_TOPICS.USER_REGISTERED,
        source: 'monolith-e2e',
        payload: { userId: tokens.user.id, email: 'ada@example.com', displayName: 'Ada' },
      });
    });

    it('POST /v1/auth/register with a taken email → 409 EMAIL_TAKEN', async () => {
      const response = await inject({ method: 'POST', url: '/v1/auth/register', payload: ADA });
      expectProblem(response, 409, 'EMAIL_TAKEN');
    });

    it('POST /v1/auth/login → 200 (passport-local → AuthPort.login)', async () => {
      const response = await inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'ada@example.com', password: ADA.password },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<AuthTokensBody>().user.id).toBe(tokens.user.id);
    });

    it('POST /v1/auth/login with a wrong password → 401 INVALID_CREDENTIALS', async () => {
      const response = await inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'ada@example.com', password: 'not the password' },
      });
      expectProblem(response, 401, 'INVALID_CREDENTIALS');
    });

    it('GET /v1/auth/me with the access token → 200', async () => {
      const response = await inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: bearer(tokens.accessToken),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        id: tokens.user.id,
        email: 'ada@example.com',
        displayName: 'Ada',
        roles: ['user'],
      });
    });

    it('GraphQL { me } with the access token', async () => {
      const response = await inject(
        graphql('{ me { id email displayName roles } }', undefined, bearer(tokens.accessToken)),
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        data: {
          me: { id: tokens.user.id, email: 'ada@example.com', displayName: 'Ada', roles: ['USER'] },
        },
      });
    });

    it('GraphQL { me } without a token → UNAUTHENTICATED error with the request id', async () => {
      const response = await inject(
        graphql('{ me { id } }', undefined, { [HTTP_HEADERS.REQUEST_ID]: 'gql-anonymous-1' }),
      );
      const { errors } = response.json<{ errors: { extensions: Record<string, unknown> }[] }>();
      expect(errors[0]?.extensions).toMatchObject({
        code: 'MISSING_TOKEN',
        status: 401,
        requestId: 'gql-anonymous-1',
      });
    });

    it('POST /v1/auth/refresh rotates the pair; the old refresh token is then rejected as reused', async () => {
      const rotated = await inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: tokens.refreshToken },
      });
      expect(rotated.statusCode, rotated.body).toBe(200);
      const next = rotated.json<AuthTokensBody>();
      expect(next.refreshToken).not.toBe(tokens.refreshToken);

      const replay = await inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: tokens.refreshToken },
      });
      expectProblem(replay, 401, 'REFRESH_TOKEN_REUSED');
      tokens = next;
    });

    it('POST /v1/auth/logout → 204; the access token is denylisted (Redis) → 401 TOKEN_REVOKED', async () => {
      const login = await inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'ada@example.com', password: ADA.password },
      });
      const session = login.json<AuthTokensBody>();

      const logout = await inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: bearer(session.accessToken),
        payload: { refreshToken: session.refreshToken },
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

    it('RBAC: a plain user listing users (needs users:read) → 403 FORBIDDEN', async () => {
      const response = await inject({
        method: 'GET',
        url: '/v1/users',
        headers: bearer(tokens.accessToken),
      });
      expectProblem(response, 403, 'FORBIDDEN');
    });

    it('RBAC: billing ?all=true needs billing:read-all → 403', async () => {
      const response = await inject({
        method: 'GET',
        url: '/v1/billing/payments?all=true',
        headers: bearer(tokens.accessToken),
      });
      expectProblem(response, 403);
    });

    it('class-validator body validation → 400 with per-field errors', async () => {
      const response = await inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: 'not-an-email', password: 'short', displayName: 'X', admin: true },
      });
      const problem = expectProblem(response, 400);
      const paths = (problem.errors as { path: string }[]).map((issue) => issue.path);
      expect(paths).toEqual(expect.arrayContaining(['email', 'password', 'admin']));
    });

    it('zod (Standard Schema) query validation → 400', async () => {
      const response = await inject({
        method: 'GET',
        url: '/v1/notifications?limit=1000',
        headers: bearer(tokens.accessToken),
      });
      const problem = expectProblem(response, 400);
      expect(problem.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'limit' })]),
      );
    });

    it('unknown route → 404 problem+json', async () => {
      const response = await inject({ method: 'GET', url: '/v1/nope' });
      expectProblem(response, 404);
    });

    it('unsigned Stripe webhook → 422 INVALID_WEBHOOK_SIGNATURE (raw body is kept)', async () => {
      const response = await inject({
        method: 'POST',
        url: '/v1/billing/webhooks/stripe',
        payload: { id: 'evt_1', type: 'checkout.session.completed' },
      });
      expectProblem(response, 422, 'INVALID_WEBHOOK_SIGNATURE');
    });
  });

  describe('request ids', () => {
    it('echoes a safe incoming x-request-id and sets x-correlation-id', async () => {
      const response = await inject({
        method: 'GET',
        url: '/health/live',
        headers: { [HTTP_HEADERS.REQUEST_ID]: 'e2e-req.42' },
      });
      expect(response.headers[HTTP_HEADERS.REQUEST_ID]).toBe('e2e-req.42');
      expect(response.headers[HTTP_HEADERS.CORRELATION_ID]).toBe('e2e-req.42');
    });

    it('replaces an unsafe x-request-id with a fresh uuidv7 (also in the problem body)', async () => {
      const response = await inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { [HTTP_HEADERS.REQUEST_ID]: 'bad id\u0000<script>' },
      });
      const problem = expectProblem(response, 401);
      expect(isUuidV7(problem.requestId)).toBe(true);
    });
  });

  describe('other contexts through their local adapters', () => {
    it('GET /v1/notifications → the Cassandra inbox (empty)', async () => {
      const response = await inject({
        method: 'GET',
        url: '/v1/notifications?limit=5',
        headers: bearer(tokens.accessToken),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ items: [], nextPageState: null });
      expect(e2e.cassandra.executed.some(({ cql }) => /notifications_by_user/i.test(cql))).toBe(
        true,
      );
    });

    it('GET /v1/billing/payments → the payments table through drizzle (empty)', async () => {
      const response = await inject({
        method: 'GET',
        url: '/v1/billing/payments',
        headers: bearer(tokens.accessToken),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ items: [], nextCursor: null });
      const select = e2e.postgres.queries.find(({ sql }) => sql.includes('from "payments"'));
      expect(select?.params).toContain(tokens.user.id);
    });

    it('POST /v1/files streams a multipart upload into the user’s storage prefix', async () => {
      const upload = multipartFile('hello.txt', 'text/plain', 'hello from the e2e suite');
      const response = await inject({
        method: 'POST',
        url: '/v1/files',
        headers: { ...upload.headers, ...bearer(tokens.accessToken) },
        payload: upload.payload,
      });
      expect(response.statusCode, response.body).toBe(201);
      const keys = e2e.storage.listKeys(`users/${tokens.user.id}/`);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/hello\.txt$/);
    });
  });
});
