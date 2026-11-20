/*
 * Cross-domain RLS journeys (B3 Task 19, spec section 13). Identity and billing run together in the
 * REAL monolith `AppModule` on a Citus container with the three roles: migrated as app_owner, every
 * request as app_runtime (NOBYPASSRLS, FORCE RLS, local execution OFF so every shard statement runs
 * over a remote connection), the system pool as app_system, the boot guard in `enforce`. Only the
 * network edges are fakes (Redis, Cassandra, mail, Kafka, Stripe), so, unlike the e2e harnesses,
 * persistence is the real Drizzle repositories under the real policies.
 *
 * The suite runs twice over one container: once with DATABASE_PREPARE=true and once with false. The
 * runtime pool has four connections, so the interleaved block reuses each of them many times.
 * Assertions read exact rows: through HTTP as the edge would answer, through the superuser for
 * "what is really there", and through a client that logs in as app_runtime for what the policies
 * alone admit.
 *
 * Opt-in (needs Docker): INTEGRATION=1 bunx vitest run --project monolith:int rls-journeys
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV);
});

import { UsersSystemRepository } from '@domain/identity';
import { buildRlsContextSql, DRIZZLE, type DrizzleDB } from '@platform/database';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, expectProblem, graphql } from './support/http.js';
import { type RlsApp, startRlsApp } from './support/rls-app.js';

interface Tokens {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  tenantRoles: string[];
  user: { id: string; email: string };
}

interface Principal {
  userId: string;
  tenantId: string;
  /** `SET LOCAL app.elevated = 'on'` after BEGIN, as `RlsElevation.elevate` does. */
  elevated?: boolean;
}

const PASSWORD = 'correct horse battery staple';
const sorted = (ids: readonly string[]): string[] => [...ids].sort();

describe.skipIf(process.env['INTEGRATION'] !== '1')('cross-domain RLS journeys (Citus)', () => {
  let pg: RlsTestPostgres | undefined;

  beforeAll(async () => {
    pg = await startRlsTestPostgres({ localExecution: false });
  });

  afterAll(async () => {
    await pg?.stop();
  });

  describe.each([true, false])('DATABASE_PREPARE=%s', (prepare) => {
    let rls: RlsApp;
    /** Keeps emails unique across the two runs, which share one database. */
    const tag = prepare ? 'p1' : 'p0';

    const email = (name: string): string => `${name}.${tag}@rls.example.com`;
    const send = (
      method: 'GET' | 'POST' | 'PATCH',
      url: string,
      token?: string,
      payload?: object,
    ) =>
      rls.app.inject({
        method,
        url,
        ...(token === undefined ? {} : { headers: bearer(token) }),
        ...(payload === undefined ? {} : { payload }),
      });

    const register = async (name: string): Promise<Tokens> => {
      const res = await send('POST', '/v1/auth/register', undefined, {
        email: email(name),
        password: PASSWORD,
        displayName: name,
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<Tokens>();
    };

    /** A pending payment of `token`'s principal in its active tenant; returns the payment id. */
    const checkout = async (token: string): Promise<string> => {
      const res = await send('POST', '/v1/billing/checkout-sessions', token, {
        priceId: 'price_rls_journeys',
        quantity: 1,
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ paymentId: string }>().paymentId;
    };

    const payments = async (token: string, all = false): Promise<string[]> => {
      const res = await send(
        'GET',
        `/v1/billing/payments?limit=100${all ? '&all=true' : ''}`,
        token,
      );
      expect(res.statusCode, res.body).toBe(200);
      return sorted(res.json<{ items: { id: string }[] }>().items.map((p) => p.id));
    };

    const tenantIds = async (token: string): Promise<string[]> => {
      const res = await send('GET', '/v1/tenants', token);
      expect(res.statusCode, res.body).toBe(200);
      return sorted(res.json<{ id: string }[]>().map((t) => t.id));
    };

    const memberEmails = async (token: string): Promise<string[]> => {
      const res = await send('GET', '/v1/tenant/members', token);
      expect(res.statusCode, res.body).toBe(200);
      return res
        .json<{ items: { email: string }[] }>()
        .items.map((m) => m.email)
        .sort();
    };

    /** The raw token of the last invitation mail queued for `to`. */
    const mailedToken = (to: string): string => {
      type InvitationJob = { to?: string; context?: { token?: unknown } };
      const job = [...rls.mailQueue.jobs]
        .reverse()
        .find((j) => j.name === 'tenant-invitation' && (j.data as InvitationJob).to === to);
      return String((job?.data as InvitationJob | undefined)?.context?.token);
    };

    /** `owner` invites `invitee` (registered already) with `roles`; `invitee` accepts and switches. */
    const joinTenant = async (owner: Tokens, invitee: Tokens, roles: string[]): Promise<Tokens> => {
      const invite = await send('POST', '/v1/tenant/invitations', owner.accessToken, {
        email: invitee.user.email,
        roles,
      });
      expect(invite.statusCode, invite.body).toBe(201);
      const accepted = await send('POST', '/v1/invitations/accept', invitee.accessToken, {
        token: mailedToken(invitee.user.email),
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      return switchTo(invitee, owner.tenantId);
    };

    const switchTo = async (who: Tokens, tenantId: string): Promise<Tokens> => {
      const res = await send('POST', '/v1/auth/switch-tenant', who.accessToken, {
        tenantId,
        refreshToken: who.refreshToken,
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<Tokens>();
    };

    /** `work` in one app_runtime transaction with the RLS context of `principal` (no application code). */
    const asRuntime = <T>(
      principal: Principal,
      work: (tx: TransactionSql) => Promise<T>,
    ): Promise<T> =>
      rls.runtime.begin(async (tx) => {
        await tx
          .unsafe(buildRlsContextSql({ userId: principal.userId, tenantId: principal.tenantId }))
          .simple();
        if (principal.elevated === true) await tx.unsafe("SET LOCAL app.elevated = 'on'").simple();
        return work(tx);
      }) as Promise<T>;

    const idsOf = (rows: readonly { id: string }[]): string[] => sorted(rows.map((r) => r.id));

    beforeAll(async () => {
      if (pg === undefined) throw new Error('postgres did not start');
      rls = await startRlsApp(pg, { prepare, poolMax: 4 });
    });

    afterAll(async () => {
      await rls?.close();
      vi.unstubAllEnvs();
    });

    it('boots under the enforcing guard on the three roles, with a four-connection runtime pool', async () => {
      // The guard ran at boot (DatabaseModule); enforce would have refused to start the app.
      expect(process.env['DATABASE_BOOT_GUARD']).toBe('enforce');
      const db = rls.app.get<DrizzleDB>(DRIZZLE);
      expect(db.$client.options.max).toBe(4);
      expect(db.$client.options.prepare).toBe(prepare);
      const [role] = await db.$client<{ current_user: string; bypass: boolean }[]>`
        select current_user, (select rolbypassrls from pg_roles where rolname = current_user) as bypass`;
      expect(role).toEqual({ current_user: 'app_runtime', bypass: false });
      const forced = await rls.admin<{ relname: string }[]>`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('identity', 'billing', 'ai') and c.relkind = 'r'
          and c.relname <> '__drizzle_migrations' and not c.relforcerowsecurity`;
      expect(forced).toEqual([]);
    });

    it('two users register and get separate tenants', async () => {
      const ada = await register('ada.sep');
      const bob = await register('bob.sep');
      expect(ada.tenantId).not.toBe(bob.tenantId);
      expect(ada.tenantRoles).toEqual(['owner']);
      expect(bob.tenantRoles).toEqual(['owner']);

      const memberships = await rls.admin<
        { tenant_id: string; user_id: string; roles: string[] }[]
      >`
        select tenant_id, user_id, roles from identity.memberships
        where user_id in ${rls.admin([ada.user.id, bob.user.id])} order by user_id`;
      expect(memberships).toEqual(
        [
          { tenant_id: ada.tenantId, user_id: ada.user.id, roles: ['owner'] },
          { tenant_id: bob.tenantId, user_id: bob.user.id, roles: ['owner'] },
        ].sort((a, b) => a.user_id.localeCompare(b.user_id)),
      );
      expect(await tenantIds(ada.accessToken)).toEqual([ada.tenantId]);
      expect(await tenantIds(bob.accessToken)).toEqual([bob.tenantId]);
    });

    it('neither user reads the other one: user, tenant, memberships, sessions, payments', async () => {
      const ada = await register('ada.iso');
      const bob = await register('bob.iso');
      const adaPayments = sorted([
        await checkout(ada.accessToken),
        await checkout(ada.accessToken),
      ]);
      const bobPayments = sorted([await checkout(bob.accessToken)]);

      // Through the query handlers, as the edge answers.
      expect(await payments(ada.accessToken)).toEqual(adaPayments);
      expect(await payments(ada.accessToken, true)).toEqual(adaPayments);
      expect(await payments(bob.accessToken)).toEqual(bobPayments);
      expect(await payments(bob.accessToken, true)).toEqual(bobPayments);
      expect(await memberEmails(ada.accessToken)).toEqual([ada.user.email]);
      expect(await memberEmails(bob.accessToken)).toEqual([bob.user.email]);
      expect(await tenantIds(ada.accessToken)).toEqual([ada.tenantId]);
      expect(await tenantIds(bob.accessToken)).toEqual([bob.tenantId]);
      expectProblem(await send('GET', `/v1/users/${bob.user.id}`, ada.accessToken), 404);
      expectProblem(await send('GET', `/v1/users/${ada.user.id}`, bob.accessToken), 404);
      const me = await send('GET', `/v1/users/${ada.user.id}`, ada.accessToken);
      expect(me.statusCode, me.body).toBe(200);

      // Through app_runtime with only the policies in the way: every table, exact rows.
      const sessionsOf = async (userId: string): Promise<string[]> =>
        idsOf(
          await rls.admin<
            { id: string }[]
          >`select id from identity.sessions where user_id = ${userId}`,
        );
      const adaSessions = await sessionsOf(ada.user.id);
      const bobSessions = await sessionsOf(bob.user.id);
      expect(adaSessions).toHaveLength(1);
      expect(bobSessions).toHaveLength(1);
      const seen = (who: Tokens, elevated = false) =>
        asRuntime({ userId: who.user.id, tenantId: who.tenantId, elevated }, async (tx) => ({
          users: idsOf(await tx<{ id: string }[]>`select id from identity.users`),
          tenants: idsOf(await tx<{ id: string }[]>`select id from identity.tenants`),
          memberships: (
            await tx<{ tenant_id: string; user_id: string }[]>`
              select tenant_id, user_id from identity.memberships`
          ).map((m) => `${m.tenant_id}/${m.user_id}`),
          sessions: idsOf(await tx<{ id: string }[]>`select id from identity.sessions`),
          payments: idsOf(await tx<{ id: string }[]>`select id from billing.payments`),
        }));
      expect(await seen(ada)).toEqual({
        users: [ada.user.id],
        tenants: [ada.tenantId],
        memberships: [`${ada.tenantId}/${ada.user.id}`],
        sessions: adaSessions,
        payments: adaPayments,
      });
      expect(await seen(bob)).toEqual({
        users: [bob.user.id],
        tenants: [bob.tenantId],
        memberships: [`${bob.tenantId}/${bob.user.id}`],
        sessions: bobSessions,
        payments: bobPayments,
      });
      // Elevation widens a tenant's own rows, never another tenant's.
      expect((await seen(ada, true)).payments).toEqual(adaPayments);
      expect((await seen(bob, true)).payments).toEqual(bobPayments);
    });

    it('invite, accept and switch: the invitee gets the inviter tenant data and none of a third tenant', async () => {
      const ada = await register('ada.inv');
      const bob = await register('bob.inv');
      const carol = await register('carol.inv');
      const adaPayment = await checkout(ada.accessToken);
      const carolPayment = await checkout(carol.accessToken);

      // Before the invitation Bob sees nothing of Ada's tenant.
      expect(await tenantIds(bob.accessToken)).toEqual([bob.tenantId]);
      const inAda = await joinTenant(ada, bob, ['admin']);
      expect(inAda).toMatchObject({ tenantId: ada.tenantId, tenantRoles: ['admin'] });

      expect(await memberEmails(inAda.accessToken)).toEqual(
        [ada.user.email, bob.user.email].sort(),
      );
      expect(await tenantIds(inAda.accessToken)).toEqual(sorted([ada.tenantId, bob.tenantId]));
      // billing:read-all (admin) lists the tenant's payments, and only that tenant's.
      expect(await payments(inAda.accessToken, true)).toEqual([adaPayment]);
      expect(await payments(inAda.accessToken, true)).not.toContain(carolPayment);
      // Nothing of Carol's tenant, by any route.
      expect(await tenantIds(inAda.accessToken)).not.toContain(carol.tenantId);
      expectProblem(await send('GET', `/v1/users/${carol.user.id}`, inAda.accessToken), 404);
      const hostile = await send('POST', '/v1/auth/switch-tenant', inAda.accessToken, {
        tenantId: carol.tenantId,
        refreshToken: inAda.refreshToken,
      });
      expect(hostile.statusCode, hostile.body).toBe(403);

      // The invitation's rows, as stored: one membership, one accepted invitation, one audit row.
      const [membership] = await rls.admin<{ roles: string[] }[]>`
        select roles from identity.memberships where tenant_id = ${ada.tenantId} and user_id = ${bob.user.id}`;
      expect(membership).toEqual({ roles: ['admin'] });
      const audit = await rls.admin<{ type: string }[]>`
        select type from identity.audit_events where tenant_id = ${ada.tenantId} order by id`;
      expect(audit.map((a) => a.type)).toContain('invitation.accepted');
    });

    it('GraphQL Payment.user resolves co-members for an admin, and null for a former member', async () => {
      const ada = await register('ada.pu');
      const bob = await register('bob.pu');
      const carol = await register('carol.pu');
      const bobInAda = await joinTenant(ada, bob, ['admin']);
      const carolInAda = await joinTenant(ada, carol, ['member']);
      const adaPayment = await checkout(ada.accessToken);
      const bobPayment = await checkout(bobInAda.accessToken);
      const carolPayment = await checkout(carolInAda.accessToken);
      // Carol leaves: her payment stays in Ada's tenant, she stays a member of her own tenant only.
      const left = await send('POST', '/v1/tenant/leave', carolInAda.accessToken);
      expect(left.statusCode, left.body).toBe(204);

      // Bob (admin, billing:read-all) lists the tenant's payments; the users DataLoader batches the
      // owners into one GetUsersByIds, a system read of the caller's tenant (users.findByIdsInTenant).
      const res = await rls.app.inject(
        graphql(
          /* GraphQL */ `
            query {
              payments(all: true, limit: 50) {
                items { id userId user { id email } }
              }
            }
          `,
          undefined,
          bearer(bobInAda.accessToken),
        ),
      );
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{
        data?: {
          payments: {
            items: { id: string; userId: string; user: { id: string; email: string } | null }[];
          };
        };
        errors?: unknown[];
      }>();
      expect(body.errors, res.body).toBeUndefined();
      const owners = Object.fromEntries(
        (body.data?.payments.items ?? []).map((payment) => [payment.id, payment.user]),
      );
      expect(owners).toEqual({
        [adaPayment]: { id: ada.user.id, email: ada.user.email },
        [bobPayment]: { id: bob.user.id, email: bob.user.email },
        [carolPayment]: null,
      });
    });

    it('a payment created in tenant A is invisible after switching to tenant B', async () => {
      const dana = await register('dana.sw');
      const erin = await register('erin.sw');
      const inErin = await joinTenant(erin, dana, ['member']);

      const inDana = await switchTo(inErin, dana.tenantId);
      const personal = await checkout(inDana.accessToken);
      expect(await payments(inDana.accessToken)).toEqual([personal]);

      const switched = await switchTo(inDana, erin.tenantId);
      expect(switched.tenantId).toBe(erin.tenantId);
      expect(await payments(switched.accessToken)).toEqual([]);
      const shared = await checkout(switched.accessToken);
      expect(await payments(switched.accessToken)).toEqual([shared]);

      const back = await switchTo(switched, dana.tenantId);
      expect(await payments(back.accessToken)).toEqual([personal]);
      const rows = await rls.admin<{ id: string; tenant_id: string }[]>`
        select id, tenant_id from billing.payments where user_id = ${dana.user.id} order by id`;
      expect(rows).toEqual(
        [
          { id: personal, tenant_id: dana.tenantId },
          { id: shared, tenant_id: erin.tenantId },
        ].sort((a, b) => a.id.localeCompare(b.id)),
      );
    });

    it('staff switch-in reads the tenant payments with billing:read-all and leaves an audit row', async () => {
      const ada = await register('ada.staff');
      const carol = await register('carol.staff');
      const adaPayments = sorted([
        await checkout(ada.accessToken),
        await checkout(ada.accessToken),
      ]);
      const carolPayment = await checkout(carol.accessToken);
      const sam = await register('sam.staff');
      await rls.admin`update identity.users set is_platform_staff = true where id = ${sam.user.id}`;

      // Outside a switch-in, staff status reads nothing of tenant A.
      expect(await payments(sam.accessToken, true)).toEqual([]);
      const switchIn = await send(
        'POST',
        `/v1/staff/tenants/${ada.tenantId}/switch-in`,
        sam.accessToken,
        {
          reason: 'Support ticket 4711',
        },
      );
      expect(switchIn.statusCode, switchIn.body).toBe(201);
      const staff = switchIn.json<{ accessToken: string; auditEventId: string }>();

      expect(await payments(staff.accessToken, true)).toEqual(adaPayments);
      expect(await payments(staff.accessToken, true)).not.toContain(carolPayment);

      const audit = await rls.admin<{ tenant_id: string; actor_id: string; type: string }[]>`
        select tenant_id, actor_id, type from identity.audit_events where id = ${staff.auditEventId}`;
      expect(audit).toEqual([
        { tenant_id: ada.tenantId, actor_id: sam.user.id, type: 'staff.switch_in' },
      ]);
      // A non-staff caller cannot do the same.
      expectProblem(
        await send('POST', `/v1/staff/tenants/${ada.tenantId}/switch-in`, carol.accessToken, {
          reason: 'curious',
        }),
        403,
        'STAFF_ONLY',
      );
    });

    it('200 interleaved requests of four principals over four connections return only their own rows', async () => {
      const [ada, bob, cy] = [
        await register('ada.mix'),
        await register('bob.mix'),
        await register('cy.mix'),
      ] as [Tokens, Tokens, Tokens];
      const mia = await joinTenant(ada, await register('mia.mix'), ['member']);
      const made = async (who: Tokens, count: number): Promise<string[]> => {
        const ids: string[] = [];
        for (let n = 0; n < count; n += 1) ids.push(await checkout(who.accessToken));
        return sorted(ids);
      };
      const own = {
        ada: await made(ada, 1),
        bob: await made(bob, 2),
        cy: await made(cy, 3),
        mia: await made(mia, 2),
      };
      const tenantA = sorted([...own.ada, ...own.mia]);

      // Four principals; the owners alternate between elevated (tenant-wide) and plain reads, so a
      // connection that served an elevated transaction serves a plain one (or the member) next.
      const cases = [
        { name: 'ada all', who: ada, all: true, expected: tenantA },
        { name: 'bob own', who: bob, all: false, expected: own.bob },
        { name: 'mia own', who: mia, all: false, expected: own.mia },
        { name: 'cy all', who: cy, all: true, expected: own.cy },
        { name: 'ada own', who: ada, all: false, expected: own.ada },
        { name: 'bob all', who: bob, all: true, expected: own.bob },
        { name: 'mia own again', who: mia, all: false, expected: own.mia },
        { name: 'cy own', who: cy, all: false, expected: own.cy },
      ];
      const total = 200;

      // Through the app: the application scopes its own queries too, so this proves the context,
      // the unit of work and the elevation scope survive reuse of the pooled connections.
      const viaApp = await Promise.all(
        Array.from({ length: total }, async (_, i) => {
          const c = cases[i % cases.length] as (typeof cases)[number];
          const res = await send(
            'GET',
            `/v1/billing/payments?limit=100${c.all ? '&all=true' : ''}`,
            c.who.accessToken,
          );
          expect(res.statusCode, `${c.name}: ${res.body}`).toBe(200);
          return { c, ids: sorted(res.json<{ items: { id: string }[] }>().items.map((p) => p.id)) };
        }),
      );
      for (const { c, ids } of viaApp) expect(ids, c.name).toEqual(c.expected);

      // Past the application: an unfiltered SELECT under only the policies, 200 interleaved
      // transactions over a client capped at four connections.
      const viaPolicies = await Promise.all(
        Array.from({ length: total }, async (_, i) => {
          const c = cases[i % cases.length] as (typeof cases)[number];
          const ids = await asRuntime(
            { userId: c.who.user.id, tenantId: c.who.tenantId, elevated: c.all },
            async (tx) => idsOf(await tx<{ id: string }[]>`select id from billing.payments`),
          );
          return { c, ids };
        }),
      );
      for (const { c, ids } of viaPolicies) expect(ids, c.name).toEqual(c.expected);
      expect(viaApp).toHaveLength(total);
      expect(viaPolicies).toHaveLength(total);
    });

    it('a duplicate email that passes the pre-check is the 409 EMAIL_TAKEN of the unique violation', async () => {
      const first = await register('dup.mail');
      const before = await rls.admin<{ users: string; tenants: string; sessions: string }[]>`
        select (select count(*) from identity.users) as users,
               (select count(*) from identity.tenants) as tenants,
               (select count(*) from identity.sessions) as sessions`;

      // The pre-check (users.existsByEmail on the system pool) answers 409 by itself.
      const precheck = await send('POST', '/v1/auth/register', undefined, {
        email: first.user.email,
        password: PASSWORD,
        displayName: 'again',
      });
      expectProblem(precheck, 409, 'EMAIL_TAKEN');

      // Past the pre-check (the race of two concurrent registrations), the shard raises 23505 on the
      // reference table; the repository maps the relayed error and the whole unit of work rolls back.
      const system = rls.app.get(UsersSystemRepository);
      const spy = vi.spyOn(system, 'existsByEmail').mockResolvedValue(false);
      const raced = await send('POST', '/v1/auth/register', undefined, {
        email: first.user.email.toUpperCase(),
        password: PASSWORD,
        displayName: 'racer',
      });
      expect(spy).toHaveBeenCalledOnce();
      expectProblem(raced, 409, 'EMAIL_TAKEN');
      const after = await rls.admin<{ users: string; tenants: string; sessions: string }[]>`
        select (select count(*) from identity.users) as users,
               (select count(*) from identity.tenants) as tenants,
               (select count(*) from identity.sessions) as sessions`;
      expect(after).toEqual(before);
    });

    it('an UPDATE that moves a row to another tenant is refused in each domain', async () => {
      const ada = await register('ada.move');
      const bob = await register('bob.move');
      const adaPayment = await checkout(ada.accessToken);
      const elevatedAda: Principal = {
        userId: ada.user.id,
        tenantId: ada.tenantId,
        elevated: true,
      };

      // identity.memberships (a reference table): the control update passes USING and WITH CHECK ...
      await expect(
        asRuntime(elevatedAda, async (tx) => {
          const result = await tx`
            update identity.memberships set last_active_at = now()
            where tenant_id = ${ada.tenantId} and user_id = ${ada.user.id}`;
          return result.count;
        }),
      ).resolves.toBe(1);
      // ... and moving the row into Bob's tenant fails WITH CHECK (tenant_id = app.tenant_id()).
      await expect(
        asRuntime(
          elevatedAda,
          (tx) => tx`
          update identity.memberships set tenant_id = ${bob.tenantId}
          where tenant_id = ${ada.tenantId} and user_id = ${ada.user.id}`,
        ),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('row-level security'),
      });
      const membership = await rls.admin<{ tenant_id: string }[]>`
        select tenant_id from identity.memberships where user_id = ${ada.user.id}`;
      expect(membership).toEqual([{ tenant_id: ada.tenantId }]);
      // From Bob's tenant the row is not even visible to UPDATE: USING matches nothing.
      await expect(
        asRuntime({ userId: bob.user.id, tenantId: bob.tenantId, elevated: true }, async (tx) => {
          const result = await tx`
            update identity.memberships set tenant_id = ${bob.tenantId}
            where tenant_id = ${ada.tenantId} and user_id = ${ada.user.id}`;
          return result.count;
        }),
      ).resolves.toBe(0);

      // billing.payments (distributed by tenant_id): Citus refuses to change a distribution value
      // (0A000) before the WITH CHECK is evaluated, so the tenant move never reaches the policy.
      await expect(
        asRuntime(
          { userId: ada.user.id, tenantId: ada.tenantId },
          (tx) => tx`
          update billing.payments set tenant_id = ${bob.tenantId}
          where tenant_id = ${ada.tenantId} and id = ${adaPayment}`,
        ),
      ).rejects.toMatchObject({
        code: '0A000',
        message: expect.stringContaining('partition value'),
      });
      // WITH CHECK on the owner column: Ada cannot hand the row to Bob within her own tenant either.
      await expect(
        asRuntime(
          { userId: ada.user.id, tenantId: ada.tenantId },
          (tx) => tx`
          update billing.payments set user_id = ${bob.user.id}
          where tenant_id = ${ada.tenantId} and id = ${adaPayment}`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      const stored = await rls.admin<{ tenant_id: string; user_id: string }[]>`
        select tenant_id, user_id from billing.payments where id = ${adaPayment}`;
      expect(stored).toEqual([{ tenant_id: ada.tenantId, user_id: ada.user.id }]);
    });
  });
});
