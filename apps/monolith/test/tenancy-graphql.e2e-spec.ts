/*
 * Tenancy over GraphQL through the monolith's real handlers over the in-memory identity store
 * (B2-16): the same ports and rules as the REST tenancy endpoints.
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV);
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, graphql } from './support/http.js';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

interface Tokens {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  user: { id: string };
}
interface GqlResult<T = Record<string, unknown>> {
  data: T | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}
interface MailJob {
  name: string;
  data: unknown;
}
const PASSWORD = 'correct horse battery staple';

describe('tenancy GraphQL (monolith, B2-16)', () => {
  let e2e: MonolithE2e;
  let ada: Tokens;
  let bob: Tokens;
  let bobInAda: Tokens;

  const gql = async <T = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown> | undefined,
    token: string,
  ): Promise<GqlResult<T>> => {
    const res = await e2e.app.inject(graphql(query, variables, bearer(token)));
    expect(res.statusCode, res.body).toBe(200);
    return res.json<GqlResult<T>>();
  };
  const register = async (email: string, displayName: string): Promise<Tokens> => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, displayName },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Tokens>();
  };

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
    ada = await register('ada.gql@example.com', 'Ada');
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('me.activeTenant: the personal tenant, the owner role, not staff', async () => {
    const res = await gql(
      '{ me { activeTenant { tenantId roles staff tenant { personal } } } }',
      undefined,
      ada.accessToken,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({
      me: {
        activeTenant: {
          tenantId: ada.tenantId,
          roles: ['OWNER'],
          staff: false,
          tenant: { personal: true },
        },
      },
    });
  });

  it('createTenant makes Ada its owner; myTenants lists both tenants', async () => {
    const created = await gql(
      'mutation { createTenant(input: { name: "Acme" }) { tenant { id name } roles } }',
      undefined,
      ada.accessToken,
    );
    expect(created.errors).toBeUndefined();
    expect(created.data).toMatchObject({
      createTenant: { tenant: { name: 'Acme' }, roles: ['OWNER'] },
    });

    const mine = await gql<{ myTenants: { tenant: { name: string } }[] }>(
      '{ myTenants { tenant { name } } }',
      undefined,
      ada.accessToken,
    );
    expect(mine.errors).toBeUndefined();
    expect(mine.data?.myTenants).toHaveLength(2);
  });

  it('inviteMember queues the mail; acceptInvitation joins Ada tenant as a member', async () => {
    const before = e2e.mailQueue.jobs.length;
    const invited = await gql<{ inviteMember: { id: string; tenantId: string; email: string } }>(
      `mutation { inviteMember(input: { email: "bob.gql@example.com", roles: [MEMBER] }) {
        id tenantId email roles
      } }`,
      undefined,
      ada.accessToken,
    );
    expect(invited.errors).toBeUndefined();
    expect(invited.data).toMatchObject({
      inviteMember: { tenantId: ada.tenantId, email: 'bob.gql@example.com', roles: ['MEMBER'] },
    });
    const job = (e2e.mailQueue.jobs as MailJob[])
      .slice(before)
      .find((j) => j.name === 'tenant-invitation');
    const token = (job?.data as { context?: { token?: unknown } } | undefined)?.context?.token;
    expect(typeof token).toBe('string');

    bob = await register('bob.gql@example.com', 'Bob');
    const accepted = await gql(
      'mutation($token: String!) { acceptInvitation(input: { token: $token }) { tenant { id } roles } }',
      { token },
      bob.accessToken,
    );
    expect(accepted.errors).toBeUndefined();
    expect(accepted.data).toEqual({
      acceptInvitation: { tenant: { id: ada.tenantId }, roles: ['MEMBER'] },
    });
  });

  it('tenantMembers as a member (no users:read): co-members without email and roles, own row complete', async () => {
    const login = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'bob.gql@example.com', password: PASSWORD, tenantId: ada.tenantId },
    });
    expect(login.statusCode, login.body).toBe(200);
    const page = await gql<{
      tenantMembers: {
        items: {
          userId: string;
          email: string | null;
          displayName: string;
          roles: string[] | null;
        }[];
      };
    }>(
      '{ tenantMembers(limit: 10) { items { userId email displayName roles joinedAt } } }',
      undefined,
      login.json<Tokens>().accessToken,
    );
    expect(page.errors).toBeUndefined();
    const byId = new Map(page.data?.tenantMembers.items.map((m) => [m.userId, m]));
    expect(byId.get(ada.user.id)).toMatchObject({ email: null, displayName: 'Ada', roles: null });
    expect(byId.get(bob.user.id)).toMatchObject({
      email: 'bob.gql@example.com',
      displayName: 'Bob',
      roles: ['MEMBER'],
    });
  });

  it('tenantMembers lists both; updateMemberRoles promotes Bob; the last owner cannot demote herself', async () => {
    const page = await gql<{ tenantMembers: { items: { email: string; roles: string[] }[] } }>(
      '{ tenantMembers(limit: 10) { items { email roles } nextCursor } }',
      undefined,
      ada.accessToken,
    );
    expect(page.errors).toBeUndefined();
    expect(page.data?.tenantMembers.items.map((m) => m.email).sort()).toEqual([
      'ada.gql@example.com',
      'bob.gql@example.com',
    ]);

    const promoted = await gql(
      `mutation($userId: UUID!) {
        updateMemberRoles(input: { userId: $userId, roles: [ADMIN] }) { userId roles }
      }`,
      { userId: bob.user.id },
      ada.accessToken,
    );
    expect(promoted.errors).toBeUndefined();
    expect(promoted.data).toEqual({
      updateMemberRoles: { userId: bob.user.id, roles: ['ADMIN'] },
    });

    const last = await gql(
      `mutation($userId: UUID!) {
        updateMemberRoles(input: { userId: $userId, roles: [MEMBER] }) { userId }
      }`,
      { userId: ada.user.id },
      ada.accessToken,
    );
    expect(last.errors?.[0]?.extensions?.code).toBe('LAST_OWNER');
  });

  it('an admin cannot remove an owner; users:read still hides activeTenant of others; Bob can leave', async () => {
    const login = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'bob.gql@example.com', password: PASSWORD, tenantId: ada.tenantId },
    });
    expect(login.statusCode, login.body).toBe(200);
    bobInAda = login.json<Tokens>();

    const removed = await gql(
      'mutation($userId: UUID!) { removeMember(userId: $userId) }',
      { userId: ada.user.id },
      bobInAda.accessToken,
    );
    expect(removed.errors?.[0]?.extensions?.code).toBe('OWNER_RANK_REQUIRED');

    const other = await gql(
      'query($id: UUID!) { user(id: $id) { id activeTenant { tenantId } } }',
      { id: ada.user.id },
      bobInAda.accessToken,
    );
    expect(other.errors).toBeUndefined();
    expect(other.data).toEqual({ user: { id: ada.user.id, activeTenant: null } });

    const left = await gql('mutation { leaveTenant }', undefined, bobInAda.accessToken);
    expect(left.errors).toBeUndefined();
    expect(left.data).toEqual({ leaveTenant: true });
  });
});
