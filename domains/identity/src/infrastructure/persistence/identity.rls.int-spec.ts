import type { LoggerService } from '@nestjs/common';
import { generateId } from '@platform/common';
import { buildRlsContextSql, runMigrations, withPlatformMigrations } from '@platform/database';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityMigrations } from './identity.migrations.js';

/*
 * Identity RLS (0009_rls: forced RLS, explicit grants and the spec §8.2 policies, row-local per the
 * ruling of 2026-11-17: no policy reads another table) on Citus 14.2, single node, local execution
 * off (startRlsTestPostgres), so every shard statement runs over a remote connection as on a
 * cluster. Migrated as app_owner by the real runner; seeded as the superuser
 * (`url`); every case runs as raw postgres.js on the role under test, each in its own transaction
 * opened with buildRlsContextSql (the adapter's exact SET LOCAL string). Elevation is the raw
 * `SET LOCAL app.elevated = 'on'` that RlsElevation.elevate() sends.
 * Allowed writes are checked inside the transaction and rolled back; forbidden writes commit (an
 * error rolls back by itself) and the superuser then checks that nothing changed.
 * Co-member and cross-tenant reads are not policy reads any more: they are app-asserted reads on
 * the system pool with the tenant filter in the SQL (Task 11); the shape is checked here.
 * Opt-in (needs Docker): INTEGRATION=1 bunx vitest run --project identity:int identity.rls
 */

const silent: LoggerService = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const id = (suffix: string): string => `0197b000-0000-7000-8000-${suffix.padStart(12, '0')}`;
const TENANT_A = id('a0');
const TENANT_B = id('b0');
/** a1 owner of A, a2 member of A, b1 owner of B, c1 member of both. */
const A1 = id('1a1');
const A2 = id('1a2');
const B1 = id('1b1');
const C1 = id('1c1');
const INVITATION_A = id('2a0');
const INVITATION_B = id('2b0');
const SESSION_A1 = id('3a1');
const SESSION_A2 = id('3a2');
const SESSION_B1 = id('3b1');
const SESSION_C1 = id('3c1');
const EVENT_A = id('4a0');
const EVENT_B = id('4b0');
const HASH = 'h'.repeat(64);

const IDENTITY_TABLES = [
  'users',
  'tenants',
  'memberships',
  'invitations',
  'sessions',
  'audit_events',
] as const;
type IdentityTable = (typeof IDENTITY_TABLES)[number];

interface Context {
  readonly user: string;
  readonly tenant: string | null;
  readonly elevated?: boolean;
}

interface SqlFailure {
  readonly code: string | undefined;
  readonly message: string;
}

/** How `work` fails, or undefined when it succeeds. */
async function failure(work: Promise<unknown>): Promise<SqlFailure | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    return { code, message };
  }
}

/** The RLS check failure of `table` (on Citus the message may name the shard: `<table>_<digits>`). */
const rlsViolation = (table: IdentityTable): SqlFailure => ({
  code: '42501',
  message: expect.stringMatching(
    new RegExp(`^new row violates row-level security policy (".+" )?for table "${table}(_\\d+)?"$`),
  ),
});
/** The grant failure: a missing table or column privilege, before any policy runs. */
const permissionDenied = (table: string): SqlFailure => ({
  code: '42501',
  message: expect.stringMatching(new RegExp(`^permission denied for table ${table}(_\\d+)?$`)),
});
const NO_USER: SqlFailure = { code: '42501', message: 'app.user_id is not set' };

class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super('rollback');
  }
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'identity RLS (0009_rls) on Citus, local execution off',
  () => {
    let pg: RlsTestPostgres | undefined;
    let admin: Sql;
    let runtime: Sql;
    let system: Sql;
    let owner: Sql;

    const connect = (url: string): Sql => postgres(url, { max: 1, onnotice: () => undefined });

    /** One transaction as app_runtime with `context` applied as the adapter applies it. */
    const inContext = <T>(
      context: Context | null,
      work: (tx: TransactionSql) => Promise<T>,
    ): Promise<T> =>
      runtime.begin(async (tx) => {
        if (context !== null) {
          await tx
            .unsafe(buildRlsContextSql({ userId: context.user, tenantId: context.tenant }))
            .simple();
          if (context.elevated === true) await tx.unsafe(`SET LOCAL app.elevated = 'on'`);
        }
        return work(tx);
      }) as Promise<T>;

    /** Like inContext, but always rolls back: for allowed writes, checked inside. */
    const rolledBack = async <T>(
      context: Context,
      work: (tx: TransactionSql) => Promise<T>,
    ): Promise<T> => {
      try {
        await inContext(context, async (tx) => {
          throw new Rollback(await work(tx));
        });
      } catch (error) {
        if (error instanceof Rollback) return error.value as T;
        throw error;
      }
      throw new Error('unreachable');
    };

    const ids = async (
      context: Context | null,
      table: IdentityTable,
      column = 'id',
    ): Promise<string[]> => {
      const rows = await inContext(context, (tx) =>
        tx.unsafe<{ id: string }[]>(`select ${column}::text as id from identity.${table}`),
      );
      return sorted(rows.map((row) => row.id));
    };

    /** Every row of every identity table, through the superuser (the "nothing changed" check). */
    const snapshot = async (): Promise<Record<IdentityTable, unknown[]>> => {
      const out = {} as Record<IdentityTable, unknown[]>;
      for (const table of IDENTITY_TABLES) {
        out[table] = await admin.unsafe(
          `select to_jsonb(t) as row from identity.${table} t order by to_jsonb(t)::text`,
        );
      }
      return out;
    };

    const membershipKey = (tenant: string, user: string): string => `${tenant}:${user}`;
    const membershipKeys = async (context: Context | null): Promise<string[]> =>
      ids(context, 'memberships', `tenant_id::text || ':' || user_id`);

    beforeAll(async () => {
      pg = await startRlsTestPostgres();
      await runMigrations(pg.migrationUrl, {
        migrations: withPlatformMigrations([identityMigrations]),
        logger: silent,
        applicationName: 'identity-rls-int',
      });
      admin = connect(pg.url);
      runtime = connect(pg.runtimeUrl);
      system = connect(pg.systemUrl);
      owner = connect(pg.migrationUrl);

      await admin`insert into identity.tenants (id, slug, name)
        values (${TENANT_A}, 'tenant-a', 'Tenant A'), (${TENANT_B}, 'tenant-b', 'Tenant B')`;
      for (const [userId, name] of [
        [A1, 'a1'],
        [A2, 'a2'],
        [B1, 'b1'],
        [C1, 'c1'],
      ] as const) {
        await admin`insert into identity.users (id, email, password_hash, display_name)
          values (${userId}, ${`${name}@example.com`}, 'hash', ${name})`;
      }
      await admin`insert into identity.memberships (tenant_id, user_id, roles) values
        (${TENANT_A}, ${A1}, '{owner}'), (${TENANT_A}, ${A2}, '{member}'),
        (${TENANT_A}, ${C1}, '{member}'), (${TENANT_B}, ${B1}, '{owner}'),
        (${TENANT_B}, ${C1}, '{member}')`;
      await admin`insert into identity.invitations
          (tenant_id, id, email, roles, token_hash, invited_by, expires_at) values
        (${TENANT_A}, ${INVITATION_A}, 'new-a@example.com', '{member}', ${HASH}, ${A1},
          now() + interval '1 day'),
        (${TENANT_B}, ${INVITATION_B}, 'new-b@example.com', '{member}', ${HASH}, ${B1},
          now() + interval '1 day')`;
      await admin`insert into identity.sessions
          (id, user_id, tenant_id, refresh_token_hash, expires_at) values
        (${SESSION_A1}, ${A1}, ${TENANT_A}, ${HASH}, now() + interval '1 day'),
        (${SESSION_A2}, ${A2}, ${TENANT_A}, ${HASH}, now() + interval '1 day'),
        (${SESSION_B1}, ${B1}, ${TENANT_B}, ${HASH}, now() + interval '1 day'),
        (${SESSION_C1}, ${C1}, ${TENANT_B}, ${HASH}, now() + interval '1 day')`;
      await admin`insert into identity.audit_events (tenant_id, id, actor_id, type) values
        (${TENANT_A}, ${EVENT_A}, ${A1}, 'tenant.created'),
        (${TENANT_B}, ${EVENT_B}, ${B1}, 'tenant.created')`;
    });

    afterAll(async () => {
      await owner?.end({ timeout: 5 });
      await system?.end({ timeout: 5 });
      await runtime?.end({ timeout: 5 });
      await admin?.end({ timeout: 5 });
      await pg?.stop();
    });

    it('runs as app_runtime with local execution off and SET LOCAL propagation (as on a cluster)', async () => {
      const [row] = await inContext(
        { user: A2, tenant: TENANT_A },
        (tx) =>
          tx<{ role: string; local: string; propagate: string }[]>`
          select current_user as role,
            current_setting('citus.enable_local_execution') as local,
            current_setting('citus.propagate_set_commands') as propagate`,
      );
      expect(row).toEqual({ role: 'app_runtime', local: 'off', propagate: 'local' });
    });

    describe('users', () => {
      it('a user reads only its own row, with or without a tenant, elevated or not', async () => {
        expect(await ids({ user: A2, tenant: TENANT_A }, 'users')).toEqual([A2]);
        expect(await ids({ user: A2, tenant: null }, 'users')).toEqual([A2]);
        expect(await ids({ user: A1, tenant: TENANT_A, elevated: true }, 'users')).toEqual([A1]);
        expect(await ids({ user: B1, tenant: TENANT_B }, 'users')).toEqual([B1]);
        expect(await ids({ user: C1, tenant: TENANT_B }, 'users')).toEqual([C1]);
      });

      it('a co-member is not readable through the runtime pool; b1 never reads a1', async () => {
        const read = async (context: Context, user: string): Promise<number> =>
          (await inContext(context, (tx) => tx`select 1 from identity.users where id = ${user}`))
            .length;
        expect(await read({ user: A2, tenant: TENANT_A }, A1)).toBe(0);
        expect(await read({ user: A2, tenant: TENANT_A }, C1)).toBe(0);
        expect(await read({ user: C1, tenant: TENANT_B }, B1)).toBe(0);
        expect(await read({ user: B1, tenant: TENANT_B }, A1)).toBe(0);
        expect(await read({ user: B1, tenant: null }, A1)).toBe(0);
      });

      it("the system directory read (users JOIN memberships on the asserted tenant) returns that tenant's members only", async () => {
        const directory = async (tenant: string): Promise<string[]> =>
          sorted(
            (
              await system.begin(
                (tx) => tx<{ id: string }[]>`
                  select u.id::text as id from identity.users u
                  join identity.memberships m on m.user_id = u.id
                  where m.tenant_id = ${tenant}`,
              )
            ).map((row) => row.id),
          );
        expect(await directory(TENANT_A)).toEqual(sorted([A1, A2, C1]));
        expect(await directory(TENANT_B)).toEqual(sorted([B1, C1]));
      });

      it("a2 updates its own display_name, but not a1's", async () => {
        const own = await rolledBack({ user: A2, tenant: TENANT_A }, async (tx) => {
          const result = await tx`update identity.users set display_name = 'A2 renamed'
            where id = ${A2}`;
          const [row] = await tx<{ name: string }[]>`
            select display_name as name from identity.users where id = ${A2}`;
          return { count: result.count, name: row?.name };
        });
        expect(own).toEqual({ count: 1, name: 'A2 renamed' });

        const before = await snapshot();
        const other = await inContext(
          { user: A2, tenant: TENANT_A },
          (tx) => tx`update identity.users set display_name = 'hijacked' where id = ${A1}`,
        );
        expect(other.count).toBe(0);
        expect(await snapshot()).toEqual(before);
      });

      it('a user inserts itself (register) but cannot insert another id', async () => {
        const fresh = generateId();
        const inserted = await rolledBack({ user: fresh, tenant: null }, async (tx) => {
          await tx`insert into identity.users (id, email, password_hash, display_name)
            values (${fresh}, ${`${fresh}@example.com`}, 'hash', 'fresh')`;
          return (
            await tx<{ id: string }[]>`select id::text from identity.users where id = ${fresh}`
          ).length;
        });
        expect(inserted).toBe(1);

        const before = await snapshot();
        const other = generateId();
        expect(
          await failure(
            inContext(
              { user: A2, tenant: TENANT_A },
              (tx) =>
                tx`insert into identity.users (id, email, password_hash, display_name)
                values (${other}, ${`${other}@example.com`}, 'hash', 'other')`,
            ),
          ),
        ).toEqual(rlsViolation('users'));
        expect(await snapshot()).toEqual(before);
      });

      it('nobody sets is_platform_staff: the insert check refuses it, the UPDATE column list leaves it out (own row included)', async () => {
        const before = await snapshot();
        const fresh = generateId();
        expect(
          await failure(
            inContext(
              { user: fresh, tenant: null },
              (tx) =>
                tx`insert into identity.users (id, email, password_hash, display_name, is_platform_staff)
                values (${fresh}, ${`${fresh}@example.com`}, 'hash', 'staff', true)`,
            ),
          ),
        ).toEqual(rlsViolation('users'));
        expect(
          await failure(
            inContext(
              { user: A2, tenant: TENANT_A },
              (tx) => tx`update identity.users set is_platform_staff = true where id = ${A2}`,
            ),
          ),
        ).toEqual(permissionDenied('users'));
        expect(await snapshot()).toEqual(before);
      });

      it('a platform staff user still updates its own profile (the update check does not read the flag)', async () => {
        await admin`update identity.users set is_platform_staff = true where id = ${A2}`;
        try {
          const own = await rolledBack(
            { user: A2, tenant: TENANT_A },
            (tx) => tx`update identity.users set display_name = 'Staff A2' where id = ${A2}`,
          );
          expect(own.count).toBe(1);
        } finally {
          await admin`update identity.users set is_platform_staff = false where id = ${A2}`;
        }
      });

      it('nobody deletes a user, elevated or not', async () => {
        const before = await snapshot();
        for (const elevated of [false, true]) {
          expect(
            await failure(
              inContext(
                { user: A2, tenant: TENANT_A, elevated },
                (tx) => tx`delete from identity.users where id = ${A2}`,
              ),
            ),
          ).toEqual(permissionDenied('users'));
        }
        expect(await snapshot()).toEqual(before);
      });
    });

    describe('tenants', () => {
      it('a2 in A reads {A}; c1 reads only its session tenant, none without one; b1 never reads A', async () => {
        expect(await ids({ user: A2, tenant: TENANT_A }, 'tenants')).toEqual([TENANT_A]);
        expect(await ids({ user: C1, tenant: TENANT_B }, 'tenants')).toEqual([TENANT_B]);
        expect(await ids({ user: C1, tenant: null }, 'tenants')).toEqual([]);
        expect(await ids({ user: B1, tenant: TENANT_B }, 'tenants')).toEqual([TENANT_B]);
        expect(await ids({ user: B1, tenant: null }, 'tenants')).toEqual([]);
      });

      it("the system read of the caller's tenants (own memberships first, then those ids) returns exactly them", async () => {
        const memberOf = await inContext(
          { user: C1, tenant: null },
          (tx) =>
            tx<{ id: string }[]>`select tenant_id::text as id from identity.memberships
            where user_id = ${C1}`,
        );
        const tenantIds = memberOf.map((row) => row.id);
        const rows = await system.begin(
          (tx) => tx<{ id: string }[]>`select id::text as id from identity.tenants
            where id = any(${tenantIds}::uuid[])`,
        );
        expect(sorted(rows.map((row) => row.id))).toEqual(sorted([TENANT_A, TENANT_B]));
      });

      it('an insert passes only with id = the current tenant', async () => {
        const fresh = generateId();
        const inserted = await rolledBack({ user: A2, tenant: fresh }, async (tx) => {
          await tx`insert into identity.tenants (id, slug, name)
            values (${fresh}, ${`t-${fresh.slice(-12)}`}, 'Fresh')`;
          return (
            await tx<{ id: string }[]>`select id::text from identity.tenants where id = ${fresh}`
          ).length;
        });
        expect(inserted).toBe(1);

        const before = await snapshot();
        const other = generateId();
        expect(
          await failure(
            inContext(
              { user: A2, tenant: TENANT_A },
              (tx) =>
                tx`insert into identity.tenants (id, slug, name)
                values (${other}, ${`t-${other.slice(-12)}`}, 'Other')`,
            ),
          ),
        ).toEqual(rlsViolation('tenants'));
        expect(await snapshot()).toEqual(before);
      });

      it('a rename needs elevation and never touches B', async () => {
        const before = await snapshot();
        const unelevated = await inContext(
          { user: A1, tenant: TENANT_A },
          (tx) => tx`update identity.tenants set name = 'Renamed' where id = ${TENANT_A}`,
        );
        expect(unelevated.count).toBe(0);
        const crossTenant = await inContext(
          { user: A1, tenant: TENANT_A, elevated: true },
          (tx) => tx`update identity.tenants set name = 'Renamed' where id = ${TENANT_B}`,
        );
        expect(crossTenant.count).toBe(0);
        expect(await snapshot()).toEqual(before);

        const elevated = await rolledBack(
          { user: A1, tenant: TENANT_A, elevated: true },
          async (tx) => {
            const result = await tx`update identity.tenants set name = 'Renamed'`;
            const rows = await tx<{ id: string }[]>`
            select id::text from identity.tenants where name = 'Renamed'`;
            return { count: result.count, ids: rows.map((row) => row.id) };
          },
        );
        expect(elevated).toEqual({ count: 1, ids: [TENANT_A] });
      });

      it('nobody deletes a tenant', async () => {
        expect(
          await failure(
            inContext(
              { user: A1, tenant: TENANT_A, elevated: true },
              (tx) => tx`delete from identity.tenants where id = ${TENANT_A}`,
            ),
          ),
        ).toEqual(permissionDenied('tenants'));
      });
    });

    describe('memberships', () => {
      it("a2 in A reads A's three rows, with no tenant only its own", async () => {
        expect(await membershipKeys({ user: A2, tenant: TENANT_A })).toEqual(
          sorted([
            membershipKey(TENANT_A, A1),
            membershipKey(TENANT_A, A2),
            membershipKey(TENANT_A, C1),
          ]),
        );
        expect(await membershipKeys({ user: A2, tenant: null })).toEqual([
          membershipKey(TENANT_A, A2),
        ]);
        expect(await membershipKeys({ user: C1, tenant: null })).toEqual(
          sorted([membershipKey(TENANT_A, C1), membershipKey(TENANT_B, C1)]),
        );
      });

      it('insert, role update and removing another member need elevation', async () => {
        const before = await snapshot();
        expect(
          await failure(
            inContext(
              { user: A1, tenant: TENANT_A },
              (tx) => tx`insert into identity.memberships (tenant_id, user_id, roles)
                values (${TENANT_A}, ${B1}, '{member}')`,
            ),
          ),
        ).toEqual(rlsViolation('memberships'));
        const roleUpdate = await inContext(
          { user: A1, tenant: TENANT_A },
          (tx) => tx`update identity.memberships set roles = '{admin}'
            where tenant_id = ${TENANT_A} and user_id = ${A2}`,
        );
        expect(roleUpdate.count).toBe(0);
        const ownRoles = await inContext(
          { user: A2, tenant: TENANT_A },
          (tx) => tx`update identity.memberships set roles = '{owner}'
            where tenant_id = ${TENANT_A} and user_id = ${A2}`,
        );
        expect(ownRoles.count).toBe(0);
        const removal = await inContext(
          { user: A1, tenant: TENANT_A },
          (tx) => tx`delete from identity.memberships
            where tenant_id = ${TENANT_A} and user_id = ${A2}`,
        );
        expect(removal.count).toBe(0);
        expect(await snapshot()).toEqual(before);

        const elevated = await rolledBack(
          { user: A1, tenant: TENANT_A, elevated: true },
          async (tx) => {
            const inserted = await tx`insert into identity.memberships (tenant_id, user_id, roles)
            values (${TENANT_A}, ${B1}, '{member}')`;
            const updated = await tx`update identity.memberships set roles = '{admin}'
            where tenant_id = ${TENANT_A} and user_id = ${A2}`;
            const removed = await tx`delete from identity.memberships
            where tenant_id = ${TENANT_A} and user_id = ${C1}`;
            return [inserted.count, updated.count, removed.count];
          },
        );
        expect(elevated).toEqual([1, 1, 1]);
      });

      it('a2 deletes its own row (leaving) without elevation', async () => {
        const left = await rolledBack({ user: A2, tenant: TENANT_A }, async (tx) => {
          const result = await tx`delete from identity.memberships
            where tenant_id = ${TENANT_A} and user_id = ${A2}`;
          const rows = await tx<{ n: number }[]>`
            select count(*)::int as n from identity.memberships
            where tenant_id = ${TENANT_A} and user_id = ${A2}`;
          return { count: result.count, remaining: rows[0]?.n };
        });
        expect(left).toEqual({ count: 1, remaining: 0 });
      });

      it("elevated a1 cannot touch B's rows", async () => {
        const before = await snapshot();
        const context = { user: A1, tenant: TENANT_A, elevated: true };
        const updated = await inContext(
          context,
          (tx) =>
            tx`update identity.memberships set roles = '{admin}' where tenant_id = ${TENANT_B}`,
        );
        expect(updated.count).toBe(0);
        const removed = await inContext(
          context,
          (tx) => tx`delete from identity.memberships where tenant_id = ${TENANT_B}`,
        );
        expect(removed.count).toBe(0);
        expect(
          await failure(
            inContext(
              context,
              (tx) => tx`insert into identity.memberships (tenant_id, user_id, roles)
                values (${TENANT_B}, ${A1}, '{owner}')`,
            ),
          ),
        ).toEqual(rlsViolation('memberships'));
        expect(await snapshot()).toEqual(before);
      });
    });

    describe('invitations', () => {
      it("an unelevated member reads none; elevated reads A's only", async () => {
        expect(await ids({ user: A2, tenant: TENANT_A }, 'invitations')).toEqual([]);
        expect(await ids({ user: A1, tenant: TENANT_A, elevated: true }, 'invitations')).toEqual([
          INVITATION_A,
        ]);
      });

      it('an elevated insert for B is rejected; for A it passes', async () => {
        const context = { user: A1, tenant: TENANT_A, elevated: true };
        const insert = (tx: TransactionSql, tenant: string, invitation: string) =>
          tx`insert into identity.invitations
              (tenant_id, id, email, roles, token_hash, invited_by, expires_at)
            values (${tenant}, ${invitation}, 'x@example.com', '{member}', ${'x'.repeat(64)}, ${A1},
              now() + interval '1 day')`;
        const before = await snapshot();
        expect(
          await failure(inContext(context, (tx) => insert(tx, TENANT_B, generateId()))),
        ).toEqual(rlsViolation('invitations'));
        expect(
          await failure(
            inContext({ user: A1, tenant: TENANT_A }, (tx) => insert(tx, TENANT_A, generateId())),
          ),
        ).toEqual(rlsViolation('invitations'));
        expect(await snapshot()).toEqual(before);

        const fresh = generateId();
        const inserted = await rolledBack(context, async (tx) => {
          await insert(tx, TENANT_A, fresh);
          return (
            await tx<
              { id: string }[]
            >`select id::text from identity.invitations where id = ${fresh}`
          ).length;
        });
        expect(inserted).toBe(1);
      });

      it("update and delete need elevation and never reach B's rows", async () => {
        const before = await snapshot();
        const unelevated = await inContext(
          { user: A1, tenant: TENANT_A },
          (tx) => tx`update identity.invitations set accepted_at = now()`,
        );
        expect(unelevated.count).toBe(0);
        const crossTenant = await inContext(
          { user: A1, tenant: TENANT_A, elevated: true },
          (tx) => tx`delete from identity.invitations where tenant_id = ${TENANT_B}`,
        );
        expect(crossTenant.count).toBe(0);
        expect(await snapshot()).toEqual(before);

        const elevated = await rolledBack(
          { user: A1, tenant: TENANT_A, elevated: true },
          async (tx) => {
            const updated = await tx`update identity.invitations set accepted_at = now()`;
            const removed = await tx`delete from identity.invitations`;
            return [updated.count, removed.count];
          },
        );
        expect(elevated).toEqual([1, 1]);
      });
    });

    describe('sessions', () => {
      it('own sessions only', async () => {
        expect(await ids({ user: A2, tenant: TENANT_A }, 'sessions')).toEqual([SESSION_A2]);
        expect(await ids({ user: C1, tenant: TENANT_A }, 'sessions')).toEqual([SESSION_C1]);
        expect(await ids({ user: A1, tenant: TENANT_A, elevated: true }, 'sessions')).toEqual([
          SESSION_A1,
        ]);
      });

      it("revokes its own session, never another user's", async () => {
        const own = await rolledBack(
          { user: A2, tenant: TENANT_A },
          (tx) => tx`update identity.sessions set revoked_at = now() where id = ${SESSION_A2}`,
        );
        expect(own.count).toBe(1);

        const before = await snapshot();
        const other = await inContext(
          { user: A2, tenant: TENANT_A, elevated: true },
          (tx) => tx`update identity.sessions set revoked_at = now() where id = ${SESSION_A1}`,
        );
        expect(other.count).toBe(0);
        expect(await snapshot()).toEqual(before);
      });

      it('an insert for another tenant or another user is rejected; its own passes', async () => {
        const insert = (tx: TransactionSql, user: string, tenant: string, session: string) =>
          tx`insert into identity.sessions (id, user_id, tenant_id, refresh_token_hash, expires_at)
            values (${session}, ${user}, ${tenant}, ${HASH}, now() + interval '1 day')`;
        const context = { user: A2, tenant: TENANT_A };
        const before = await snapshot();
        expect(
          await failure(inContext(context, (tx) => insert(tx, A2, TENANT_B, generateId()))),
        ).toEqual(rlsViolation('sessions'));
        expect(
          await failure(inContext(context, (tx) => insert(tx, A1, TENANT_A, generateId()))),
        ).toEqual(rlsViolation('sessions'));
        expect(await snapshot()).toEqual(before);

        const fresh = generateId();
        const inserted = await rolledBack(context, async (tx) => {
          await insert(tx, A2, TENANT_A, fresh);
          return (
            await tx<{ id: string }[]>`select id::text from identity.sessions where id = ${fresh}`
          ).length;
        });
        expect(inserted).toBe(1);
      });

      it('app_runtime never deletes a session (the purge is app_system)', async () => {
        expect(
          await failure(
            inContext(
              { user: A2, tenant: TENANT_A },
              (tx) => tx`delete from identity.sessions where id = ${SESSION_A2}`,
            ),
          ),
        ).toEqual(permissionDenied('sessions'));
      });
    });

    describe('audit_events', () => {
      it('a member inserts for the current tenant only', async () => {
        const insert = (tx: TransactionSql, tenant: string, event: string) =>
          tx`insert into identity.audit_events (tenant_id, id, actor_id, type)
            values (${tenant}, ${event}, ${A2}, 'member.left')`;
        const fresh = generateId();
        const inserted = await rolledBack({ user: A2, tenant: TENANT_A }, async (tx) => {
          const result = await insert(tx, TENANT_A, fresh);
          return result.count;
        });
        expect(inserted).toBe(1);

        const before = await snapshot();
        expect(
          await failure(
            inContext({ user: A2, tenant: TENANT_A }, (tx) => insert(tx, TENANT_B, generateId())),
          ),
        ).toEqual(rlsViolation('audit_events'));
        expect(await snapshot()).toEqual(before);
      });

      it("reads need elevation, and then show the current tenant's events only", async () => {
        expect(await ids({ user: A1, tenant: TENANT_A }, 'audit_events')).toEqual([]);
        expect(await ids({ user: A1, tenant: TENANT_A, elevated: true }, 'audit_events')).toEqual([
          EVENT_A,
        ]);
      });

      it('UPDATE and DELETE fail with 42501 even when elevated', async () => {
        const before = await snapshot();
        const context = { user: A1, tenant: TENANT_A, elevated: true };
        expect(
          await failure(
            inContext(context, (tx) => tx`update identity.audit_events set type = 'tampered'`),
          ),
        ).toEqual(permissionDenied('audit_events'));
        expect(
          await failure(inContext(context, (tx) => tx`delete from identity.audit_events`)),
        ).toEqual(permissionDenied('audit_events'));
        expect(await snapshot()).toEqual(before);
      });
    });

    describe('all tables', () => {
      it('with no context, reads of users, memberships and sessions raise "app.user_id is not set"', async () => {
        for (const table of ['users', 'sessions'] as const) {
          expect(await failure(ids(null, table)), table).toEqual(NO_USER);
        }
        expect(await failure(membershipKeys(null)), 'memberships').toEqual(NO_USER);
      });

      it('with no context, tenants, invitations and audit_events return no row (or raise)', async () => {
        for (const table of ['tenants', 'invitations', 'audit_events'] as const) {
          const outcome = await ids(null, table).catch((error: unknown) => error);
          if (Array.isArray(outcome)) expect(outcome, table).toEqual([]);
          else expect((outcome as { code?: string }).code, table).toBe('42501');
        }
      });

      it('with no context, no row is inserted, updated or deleted', async () => {
        const before = await snapshot();
        const writes: Record<IdentityTable, string[]> = {
          users: [
            `insert into identity.users (id, email, password_hash, display_name)
              values ('${generateId()}', 'none@example.com', 'hash', 'none')`,
            `update identity.users set display_name = 'none'`,
          ],
          tenants: [
            `insert into identity.tenants (id, slug, name) values ('${generateId()}', 'none', 'none')`,
            `update identity.tenants set name = 'none'`,
          ],
          memberships: [
            `insert into identity.memberships (tenant_id, user_id, roles)
              values ('${TENANT_B}', '${A1}', '{member}')`,
            `update identity.memberships set roles = '{admin}'`,
            `delete from identity.memberships`,
          ],
          invitations: [
            `insert into identity.invitations
                (tenant_id, email, roles, token_hash, invited_by, expires_at)
              values ('${TENANT_A}', 'none@example.com', '{member}', 'none', '${A1}', now())`,
            `update identity.invitations set accepted_at = now()`,
            `delete from identity.invitations`,
          ],
          sessions: [
            `insert into identity.sessions (id, user_id, tenant_id, refresh_token_hash, expires_at)
              values ('${generateId()}', '${A1}', '${TENANT_A}', 'none', now())`,
            `update identity.sessions set revoked_at = now()`,
          ],
          audit_events: [
            `insert into identity.audit_events (tenant_id, type) values ('${TENANT_A}', 'none')`,
          ],
        };
        for (const [table, statements] of Object.entries(writes)) {
          for (const statement of statements) {
            const outcome = await inContext(null, (tx) => tx.unsafe(statement)).catch(
              (error: unknown) => error,
            );
            if (outcome instanceof Error) {
              expect((outcome as { code?: string }).code, `${table}: ${statement}`).toBe('42501');
            } else {
              expect((outcome as { count: number }).count, `${table}: ${statement}`).toBe(0);
            }
          }
        }
        expect(await snapshot()).toEqual(before);
      });

      it('app_system reads every row of users, tenants, memberships, invitations and sessions, and gets 42501 on audit_events', async () => {
        const read = (table: IdentityTable) =>
          system.begin((tx) =>
            tx.unsafe<{ id: string }[]>(`select id::text as id from identity.${table}`),
          ) as Promise<{ id: string }[]>;
        const all = async (table: IdentityTable): Promise<string[]> =>
          sorted(
            (
              await admin.unsafe<{ id: string }[]>(`select id::text as id from identity.${table}`)
            ).map((row) => row.id),
          );
        for (const table of ['users', 'tenants', 'invitations', 'sessions'] as const) {
          const rows = sorted((await read(table)).map((row) => row.id));
          expect(rows, table).toEqual(await all(table));
          expect(rows.length, table).toBeGreaterThanOrEqual(2);
        }
        const memberships = await system.begin(
          (tx) => tx<{ n: number }[]>`select count(*)::int as n from identity.memberships`,
        );
        expect(memberships[0]?.n).toBe(5);
        expect(
          await failure(system.begin((tx) => tx`select 1 from identity.audit_events limit 1`)),
        ).toEqual(permissionDenied('audit_events'));
        // The purge (system method 5) is a DELETE on sessions; nothing else is writable.
        const purged = await system
          .begin(async (tx) => {
            const result = await tx`delete from identity.sessions`;
            throw new Rollback(result.count);
          })
          .catch((error: unknown) => (error instanceof Rollback ? error.value : error));
        expect(purged).toBe(4);
        const before = await snapshot();
        for (const [table, statement] of [
          ['users', `update identity.users set display_name = 'x'`],
          ['tenants', `update identity.tenants set name = 'x'`],
          ['memberships', `update identity.memberships set roles = '{admin}'`],
          ['memberships', `delete from identity.memberships`],
          ['invitations', `delete from identity.invitations`],
        ] as const) {
          expect(await failure(system.begin((tx) => tx.unsafe(statement))), statement).toEqual(
            permissionDenied(table),
          );
        }
        expect(await snapshot()).toEqual(before);
      });

      it('app_owner reads zero rows except in users, where it can set is_platform_staff', async () => {
        const [whoami] = await owner<{ role: string }[]>`select current_user as role`;
        expect(whoami?.role).toBe('app_owner');
        for (const table of [
          'tenants',
          'memberships',
          'invitations',
          'sessions',
          'audit_events',
        ] as const) {
          const rows = await owner.unsafe(`select 1 from identity.${table}`);
          expect(rows.length, table).toBe(0);
        }
        const users = await owner<{ id: string }[]>`select id::text from identity.users`;
        expect(users.length).toBeGreaterThanOrEqual(4);

        try {
          const granted = await owner`update identity.users set is_platform_staff = true
            where email = 'a2@example.com'`;
          expect(granted.count).toBe(1);
          const [row] = await admin<{ staff: boolean }[]>`
            select is_platform_staff as staff from identity.users where id = ${A2}`;
          expect(row?.staff).toBe(true);
        } finally {
          await admin`update identity.users set is_platform_staff = false where id = ${A2}`;
        }
      });

      it('all six tables (and the outbox, 0010) have RLS enabled and forced; identity.__drizzle_migrations has neither and app_runtime cannot read it', async () => {
        const rows = await admin<{ name: string; enabled: boolean; forced: boolean }[]>`
          select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'identity' and c.relkind = 'r' order by c.relname`;
        // identity.outbox (0010_outbox) has its own spec: identity.outbox.rls.int-spec.ts.
        expect(rows).toEqual(
          sorted([...IDENTITY_TABLES, 'outbox', '__drizzle_migrations']).map((name) => ({
            name,
            enabled: name !== '__drizzle_migrations',
            forced: name !== '__drizzle_migrations',
          })),
        );
        expect(
          await failure(
            inContext(
              { user: A2, tenant: TENANT_A },
              (tx) => tx`select 1 from identity.__drizzle_migrations`,
            ),
          ),
        ).toEqual(permissionDenied('__drizzle_migrations'));
      });
    });
  },
);
