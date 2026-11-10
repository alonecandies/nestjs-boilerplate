await vi.hoisted(async () => {
  const { GATEWAY_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, GATEWAY_E2E_ENV, {
    TRUST_PROXY: 'loopback',
    THROTTLE_LIMIT: '1000',
    IDENTITY_CREDENTIALS_LIMIT: '100',
    IDENTITY_LOCKOUT_THRESHOLD: '3',
    IDENTITY_LOCKOUT_MS: '900000',
  });
});

import type { ProblemDetails } from '@platform/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGatewayE2eApp, type GatewayE2e } from './support/gateway-e2e-app.js';
import { expectProblem } from './support/http.js';

const PASSWORD = 'correct horse battery staple';
const WRONG = 'wrong password!!';

describe('gateway rate limits: account lockout across IPs (spec §11, wave 1)', () => {
  let e2e: GatewayE2e;
  let ipSeq = 0;
  const fromNewIp = () => {
    ipSeq += 1;
    return { 'x-forwarded-for': `203.0.113.${ipSeq % 250}` };
  };
  const login = (email: string, password: string) =>
    e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: fromNewIp(),
      payload: { email, password },
    });
  const register = (email: string) =>
    e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: fromNewIp(),
      payload: { email, password: PASSWORD, displayName: 'E2E' },
    });
  const publicPart = ({ requestId: _r, instance: _i, ...rest }: ProblemDetails) => rest;

  beforeAll(async () => {
    e2e = await createGatewayE2eApp();
  });
  beforeEach(async () => {
    await e2e.redis.flushall();
  });
  afterAll(async () => {
    await e2e?.app.close();
  });

  it('locks an account after THRESHOLD attempts from different IPs, even with the right password', async () => {
    expect((await register('erin@example.com')).statusCode).toBe(201);
    for (let i = 0; i < 3; i += 1)
      expect((await login('erin@example.com', WRONG)).statusCode).toBe(401);
    const locked = await login('erin@example.com', PASSWORD);
    expectProblem(locked, 429, 'RATE_LIMITED');
    const retryAfter = Number(locked.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(900);
    expect(String(locked.headers['ratelimit'] ?? '')).not.toContain('lockout');
  });

  it('an unknown email locks identically (no account enumeration)', async () => {
    expect((await register('frank@example.com')).statusCode).toBe(201);
    for (let i = 0; i < 3; i += 1) await login('frank@example.com', WRONG);
    const known = expectProblem(await login('frank@example.com', WRONG), 429, 'RATE_LIMITED');
    for (let i = 0; i < 3; i += 1)
      expect((await login('ghost@example.com', WRONG)).statusCode).toBe(401);
    const unknown = expectProblem(await login('ghost@example.com', WRONG), 429, 'RATE_LIMITED');
    expect(publicPart(unknown)).toEqual(publicPart(known));
  });

  it('a successful login resets the count', async () => {
    expect((await register('gina@example.com')).statusCode).toBe(201);
    for (let i = 0; i < 2; i += 1) await login('gina@example.com', WRONG);
    expect((await login('gina@example.com', PASSWORD)).statusCode).toBe(200);
    for (let i = 0; i < 3; i += 1)
      expect((await login('gina@example.com', WRONG)).statusCode).toBe(401);
  });
});
