import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV);
});

interface Tokens {
  accessToken: string;
  tenantId: string;
  user: { id: string };
}
interface MailJob {
  name: string;
  data: unknown;
  opts: unknown;
}
const PASSWORD = 'correct horse battery staple';

describe('invitations (monolith, B2-14)', () => {
  let e2e: MonolithE2e;
  let ada: Tokens;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const register = async (email: string, displayName: string): Promise<Tokens> => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, displayName },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Tokens>();
  };

  const invite = async (email: string) => {
    const before = e2e.mailQueue.jobs.length;
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/v1/tenant/invitations',
      headers: auth(ada.accessToken),
      payload: { email, roles: ['member'] },
    });
    expect(res.statusCode, res.body).toBe(201);
    const job = (e2e.mailQueue.jobs as MailJob[])
      .slice(before)
      .find((j) => j.name === 'tenant-invitation');
    const data = job?.data as { to?: string; context?: { token?: unknown } } | undefined;
    return { res, job, data, token: data?.context?.token as string };
  };

  const accept = (user: Tokens, token: string) =>
    e2e.app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: auth(user.accessToken),
      payload: { token },
    });

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
    ada = await register('ada.inv@example.com', 'Ada');
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('invite -> mail job with the raw token -> accept joins the tenant once', async () => {
    const { res, job, data, token } = await invite('bob.inv@example.com');
    expect(res.json()).toMatchObject({
      tenantId: ada.tenantId,
      email: 'bob.inv@example.com',
      roles: ['member'],
    });
    expect(res.body).not.toContain(token);
    expect(job?.opts).toMatchObject({ removeOnComplete: true, removeOnFail: true });
    expect(data?.to).toBe('bob.inv@example.com');
    expect(typeof token).toBe('string');

    const bob = await register('bob.inv@example.com', 'Bob');
    const joined = await accept(bob, token);
    expect(joined.statusCode, joined.body).toBe(200);
    expect(joined.json()).toMatchObject({ id: ada.tenantId, roles: ['member'] });

    const replay = await accept(bob, token);
    expect(replay.statusCode).toBe(404);
    expect(replay.json()).toMatchObject({ code: 'INVITATION_INVALID' });
  });

  it('403 INVITATION_EMAIL_MISMATCH for another account; 400 for an empty token', async () => {
    const { token } = await invite('bob.inv@example.com');
    const carol = await register('carol.inv@example.com', 'Carol');

    const wrong = await accept(carol, token);
    expect(wrong.statusCode, wrong.body).toBe(403);
    expect(wrong.json()).toMatchObject({ code: 'INVITATION_EMAIL_MISMATCH' });

    const empty = await accept(carol, '');
    expect(empty.statusCode).toBe(400);
  });
});
