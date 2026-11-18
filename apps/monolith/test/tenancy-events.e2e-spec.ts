import {
  MEMBERSHIP_CREATED_EVENT,
  MEMBERSHIP_REMOVED_EVENT,
  USER_REGISTERED_EVENT,
} from '@domain/identity-contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer } from './support/http.js';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV);
});

interface Tokens {
  accessToken: string;
  tenantId: string;
  user: { id: string; email: string };
}
interface Counts {
  registered: number;
  created: number;
  removed: number;
}
const PASSWORD = 'correct horse battery staple';

/**
 * B4-1 producer side: every identity event names the tenant it is about, and every membership that
 * is created or removed is published once, after its unit of work committed. The events go through
 * identity's outbox (G-1): the unit of work enqueues them and a relay tick publishes them, so
 * every check ticks the relays first, and `flushOutboxes()` (tick, then forget what was
 * published) stands where a spec starts counting.
 */
describe('identity events carry the tenant (monolith, B4-1)', () => {
  let e2e: MonolithE2e;

  const registered = () => e2e.kafka.envelopes(USER_REGISTERED_EVENT);
  const created = () => e2e.kafka.envelopes(MEMBERSHIP_CREATED_EVENT);
  const removed = () => e2e.kafka.envelopes(MEMBERSHIP_REMOVED_EVENT);
  const counts = (): Counts => ({
    registered: registered().length,
    created: created().length,
    removed: removed().length,
  });
  /** Ticks the relays and expects `expected`; then lets the bus drain and checks again after another tick (no late duplicate). */
  const expectPublished = async (expected: Counts): Promise<void> => {
    await e2e.tickRelays();
    expect(counts()).toEqual(expected);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await e2e.tickRelays();
    expect(counts()).toEqual(expected);
  };
  /** Nothing was published, also after the bus drained and the relays ticked. */
  const expectNothingPublished = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await e2e.tickRelays();
    expect(e2e.kafka.records).toEqual([]);
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
  const login = async (email: string, tenantId?: string): Promise<Tokens> => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload:
        tenantId === undefined
          ? { email, password: PASSWORD }
          : { email, password: PASSWORD, tenantId },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Tokens>();
  };
  /** Invites `email` into the inviter's tenant and returns the mailed raw token. */
  const invite = async (inviter: Tokens, email: string): Promise<string> => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/v1/tenant/invitations',
      headers: bearer(inviter.accessToken),
      payload: { email, roles: ['member'] },
    });
    expect(res.statusCode, res.body).toBe(201);
    type InvitationJob = { to?: string; context?: { token?: unknown } };
    const job = [...e2e.mailQueue.jobs]
      .reverse()
      .find((j) => j.name === 'tenant-invitation' && (j.data as InvitationJob).to === email);
    return String((job?.data as InvitationJob | undefined)?.context?.token);
  };
  const accept = (invitee: Tokens, token: string) =>
    e2e.app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: bearer(invitee.accessToken),
      payload: { token },
    });

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
  });

  beforeEach(async () => {
    await e2e.flushOutboxes();
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('register publishes one user-registered and one membership-created, both in the new workspace', async () => {
    const ada = await register('ada.events@example.com', 'Ada');

    await expectPublished({ registered: 1, created: 1, removed: 0 });
    expect(registered()[0]).toMatchObject({
      tenantId: ada.tenantId,
      actorId: ada.user.id,
      payload: { userId: ada.user.id, email: 'ada.events@example.com', displayName: 'Ada' },
    });
    expect(created()[0]).toMatchObject({
      tenantId: ada.tenantId,
      actorId: ada.user.id,
      payload: { userId: ada.user.id, email: 'ada.events@example.com', displayName: 'Ada' },
    });
    const keys = e2e.kafka.records.map((record) => record.key);
    expect(keys).toEqual([ada.user.id, ada.user.id]);
  });

  it('creating a second tenant publishes one membership-created for it', async () => {
    const ada = await register('ada.second@example.com', 'Ada');
    await e2e.flushOutboxes();

    const res = await e2e.app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer(ada.accessToken),
      payload: { name: 'Acme' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const tenant = res.json<{ id: string }>();
    expect(tenant.id).not.toBe(ada.tenantId);

    await expectPublished({ registered: 0, created: 1, removed: 0 });
    expect(created()[0]).toMatchObject({
      tenantId: tenant.id,
      actorId: ada.user.id,
      payload: { userId: ada.user.id, email: 'ada.second@example.com', displayName: 'Ada' },
    });
  });

  describe('invite, accept, remove and leave', () => {
    let ada: Tokens;
    let bob: Tokens;
    let bobToken: string;

    beforeAll(async () => {
      ada = await register('ada.members.events@example.com', 'Ada');
      bob = await register('bob.members.events@example.com', 'Bob');
      bobToken = await invite(ada, 'bob.members.events@example.com');
    });

    it('accepting publishes one membership-created for (the inviter tenant, the invitee)', async () => {
      const res = await accept(bob, bobToken);
      expect(res.statusCode, res.body).toBe(200);

      await expectPublished({ registered: 0, created: 1, removed: 0 });
      expect(created()[0]).toMatchObject({
        tenantId: ada.tenantId,
        actorId: bob.user.id,
        payload: {
          userId: bob.user.id,
          email: 'bob.members.events@example.com',
          displayName: 'Bob',
        },
      });
      expect(e2e.kafka.records[0]?.key).toBe(bob.user.id);
    });

    it('a rejected command (accepting the same invitation twice) publishes nothing', async () => {
      const replay = await accept(bob, bobToken);
      expect(replay.statusCode, replay.body).toBe(404);

      await expectNothingPublished();
    });

    it('removing that member publishes one membership-removed', async () => {
      const res = await e2e.app.inject({
        method: 'DELETE',
        url: `/v1/tenant/members/${bob.user.id}`,
        headers: bearer(ada.accessToken),
      });
      expect(res.statusCode, res.body).toBe(204);

      await expectPublished({ registered: 0, created: 0, removed: 1 });
      expect(removed()[0]).toMatchObject({
        tenantId: ada.tenantId,
        actorId: ada.user.id,
        payload: { userId: bob.user.id },
      });
      expect(e2e.kafka.records[0]?.key).toBe(bob.user.id);
    });

    it('leaving publishes one membership-removed', async () => {
      const carol = await register('carol.members.events@example.com', 'Carol');
      const accepted = await accept(carol, await invite(ada, 'carol.members.events@example.com'));
      expect(accepted.statusCode, accepted.body).toBe(200);
      const carolInAda = await login('carol.members.events@example.com', ada.tenantId);
      await e2e.flushOutboxes();

      const res = await e2e.app.inject({
        method: 'POST',
        url: '/v1/tenant/leave',
        headers: bearer(carolInAda.accessToken),
      });
      expect(res.statusCode, res.body).toBe(204);

      await expectPublished({ registered: 0, created: 0, removed: 1 });
      expect(removed()[0]).toMatchObject({
        tenantId: ada.tenantId,
        actorId: carol.user.id,
        payload: { userId: carol.user.id },
      });
    });
  });

  it('the login of a user without a membership publishes one membership-created for the new workspace', async () => {
    const dave = await register('dave.events@example.com', 'Dave');
    // A pre-tenancy account: no membership at all.
    await e2e.identity.memberships.delete(dave.tenantId, dave.user.id);
    await e2e.flushOutboxes();

    const session = await login('dave.events@example.com');

    expect(session.tenantId).not.toBe(dave.tenantId);
    await expectPublished({ registered: 0, created: 1, removed: 0 });
    expect(created()[0]).toMatchObject({
      tenantId: session.tenantId,
      actorId: dave.user.id,
      payload: { userId: dave.user.id, email: 'dave.events@example.com', displayName: 'Dave' },
    });
  });

  it('a login with an existing membership publishes nothing', async () => {
    await register('erin.events@example.com', 'Erin');
    await e2e.flushOutboxes();

    await login('erin.events@example.com');

    await expectNothingPublished();
  });
});
