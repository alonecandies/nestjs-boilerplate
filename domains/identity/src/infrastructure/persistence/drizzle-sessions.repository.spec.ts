import { generateId } from '@platform/common';
import type { DrizzleTransactionalAdapter, TransactionHost } from '@platform/database';
import { describe, expect, it, vi } from 'vitest';
import {
  affected,
  createFakePostgres,
  type FakeQueryHandler,
} from '../../../test/fake-postgres.js';
import { NOW } from '../../../test/fixtures.js';
import { DrizzleSessionsRepository } from './drizzle-sessions.repository.js';
import { DrizzleTransactionRunner } from './drizzle-transaction.runner.js';
import type { IdentitySchema } from './identity.schema.js';

type Host = TransactionHost<DrizzleTransactionalAdapter<IdentitySchema>>;

function setup(handler?: FakeQueryHandler) {
  const fake = createFakePostgres(handler);
  const txHost = { tx: fake.db } as unknown as Host;
  return { ...fake, repository: new DrizzleSessionsRepository(txHost) };
}

describe('DrizzleSessionsRepository', () => {
  const ids = {
    session: generateId(),
    user: generateId(),
    tenant: generateId(),
    successor: generateId(),
  };

  it('create inserts the hashed session', async () => {
    const { repository, executed } = setup();
    await repository.create({
      id: ids.session,
      userId: ids.user,
      tenantId: ids.tenant,
      refreshTokenHash: 'h'.repeat(64),
      userAgent: 'ua',
      ip: null,
      expiresAt: NOW,
    });
    expect(executed[0]?.sql).toMatch(
      /^insert into "identity"\."sessions" \("id", "user_id", "tenant_id", "refresh_token_hash", "user_agent", "ip", "expires_at", "revoked_at", "replaced_by_id", "created_at"\)/,
    );
  });

  it('revokeForRotation is one conditional UPDATE (compare-and-set on revoked_at IS NULL)', async () => {
    const { repository, executed } = setup(() => [{ id: ids.session }]);
    const input = {
      id: ids.session,
      userId: ids.user,
      refreshTokenHash: 'h'.repeat(64),
      replacedById: ids.successor,
      now: NOW,
    };

    await expect(repository.revokeForRotation(input)).resolves.toBe(true);

    expect(executed[0]?.sql).toBe(
      'update "identity"."sessions" set "revoked_at" = $1, "replaced_by_id" = $2 where ("identity"."sessions"."id" = $3 and "identity"."sessions"."user_id" = $4 and "identity"."sessions"."refresh_token_hash" = $5 and "identity"."sessions"."revoked_at" is null and "identity"."sessions"."expires_at" > $6) returning "id"',
    );
    expect(executed[0]?.params).toEqual([
      NOW.toISOString(),
      ids.successor,
      ids.session,
      ids.user,
      'h'.repeat(64),
      NOW.toISOString(),
    ]);

    const loser = setup(() => []);
    await expect(loser.repository.revokeForRotation(input)).resolves.toBe(false);
  });

  it('revoke / revokeAllForUser only touch active sessions; counts come from RowList.count', async () => {
    const { repository, executed } = setup((sql) =>
      sql.includes('returning') ? [{ id: ids.session }] : affected(4),
    );
    await expect(repository.revoke({ id: ids.session, userId: ids.user, now: NOW })).resolves.toBe(
      true,
    );
    await expect(repository.revokeAllForUser(ids.user, NOW)).resolves.toBe(4);

    expect(executed[0]?.sql).toContain('"identity"."sessions"."revoked_at" is null');
    expect(executed[1]?.sql).toBe(
      'update "identity"."sessions" set "revoked_at" = $1 where ("identity"."sessions"."user_id" = $2 and "identity"."sessions"."revoked_at" is null)',
    );
  });

  it('deleteExpired is ONE multi-shard DELETE on expires_at: no sub-select, no LIMIT, no row locks', async () => {
    const { repository, executed } = setup(() => affected(12));
    await expect(repository.deleteExpired(NOW)).resolves.toBe(12);
    expect(executed).toHaveLength(1);
    expect(executed[0]?.sql).toBe(
      'delete from "identity"."sessions" where "identity"."sessions"."expires_at" <= $1',
    );
    expect(executed[0]?.params).toEqual([NOW.toISOString()]);
  });

  it('findById maps the row (null when absent)', async () => {
    const { repository } = setup(() => [
      {
        id: ids.session,
        user_id: ids.user,
        tenant_id: ids.tenant,
        refresh_token_hash: 'h',
        user_agent: null,
        ip: null,
        expires_at: NOW.toISOString(),
        revoked_at: null,
        replaced_by_id: null,
        created_at: NOW.toISOString(),
      },
    ]);
    await expect(repository.findById(ids.user, ids.session)).resolves.toMatchObject({
      id: ids.session,
      userId: ids.user,
      tenantId: ids.tenant,
      expiresAt: NOW,
      revokedAt: null,
    });
    await expect(setup(() => []).repository.findById(ids.user, ids.session)).resolves.toBeNull();
  });
});

describe('DrizzleTransactionRunner', () => {
  it('delegates to TransactionHost.withTransaction (Propagation.Required)', async () => {
    const withTransaction = vi.fn(async (work: () => Promise<unknown>) => work());
    const runner = new DrizzleTransactionRunner({ withTransaction } as unknown as Host);
    await expect(runner.run(async () => 42)).resolves.toBe(42);
    expect(withTransaction).toHaveBeenCalledOnce();
  });
});
