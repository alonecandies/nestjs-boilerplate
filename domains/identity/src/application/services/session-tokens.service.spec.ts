import {
  createPrincipal,
  getPrincipal,
  runWithPrincipal,
  sha256Hex,
  UnauthenticatedException,
} from '@platform/common';
import { ClsServiceManager } from 'nestjs-cls';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakePostgres, fakeTransactionHost } from '../../../test/fake-postgres.js';
import { makeUserRecord, passThroughTransaction } from '../../../test/fixtures.js';
import { mockOf } from '../../../test/mocks.js';
import { DrizzleSessionsRepository } from '../../infrastructure/persistence/drizzle-sessions.repository.js';
import { DrizzleTransactionRunner } from '../../infrastructure/persistence/drizzle-transaction.runner.js';
import type { TokenIssuer } from '../../infrastructure/security/token-issuer.service.js';
import type { SessionsRepository } from '../persistence/sessions.repository.js';
import { SessionTokensService } from './session-tokens.service.js';

const TENANT = '0190f3b2-0000-7000-8000-0000000000aa';

describe('SessionTokensService', () => {
  const expiresAt = new Date('2026-10-06T12:00:00.000Z');
  let tokens: ReturnType<typeof mockOf<TokenIssuer>>;
  let sessions: ReturnType<typeof mockOf<SessionsRepository>>;
  let transaction: ReturnType<typeof passThroughTransaction>;
  let service: SessionTokensService;

  beforeEach(() => {
    tokens = mockOf<TokenIssuer>({
      issueRefreshToken: async () => ({ token: 'refresh-jwt', expiresAt }),
      issueAccessToken: async () => ({ token: 'access-jwt', jti: 'jti', expiresIn: 900, exp: 1 }),
    });
    sessions = mockOf<SessionsRepository>({ create: async () => undefined });
    transaction = passThroughTransaction();
    service = new SessionTokensService(tokens, sessions, transaction);
  });

  it('opens a tenant-bound session (sha256 of the refresh token only) and returns the tenant with the pair', async () => {
    const user = makeUserRecord();

    const result = await service.open({
      user,
      tenantId: TENANT,
      roles: ['owner'],
      client: { userAgent: ' curl/8 ', ip: '10.0.0.1' },
      sessionId: 'sid-1',
    });

    expect(tokens.issueRefreshToken).toHaveBeenCalledWith({ userId: user.id, sessionId: 'sid-1' });
    expect(tokens.issueAccessToken).toHaveBeenCalledWith({
      id: user.id,
      email: user.email,
      tenantId: TENANT,
      roles: ['owner'],
    });
    expect(sessions.create).toHaveBeenCalledWith({
      id: 'sid-1',
      userId: user.id,
      tenantId: TENANT,
      refreshTokenHash: sha256Hex('refresh-jwt'),
      expiresAt,
      userAgent: 'curl/8',
      ip: '10.0.0.1',
    });
    expect(result).toEqual({
      accessToken: 'access-jwt',
      refreshToken: 'refresh-jwt',
      expiresIn: 900,
      tokenType: 'Bearer',
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        roles: [],
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      tenantId: TENANT,
      tenantRoles: ['owner'],
    });
  });

  it('generates a uuidv7 session id and stores null client info when none is known', async () => {
    await service.open({ user: makeUserRecord(), tenantId: TENANT, roles: ['member'] });
    const [session] = sessions.create.mock.calls[0] ?? [];
    expect(session?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(session).toMatchObject({ tenantId: TENANT, userAgent: null, ip: null });
  });

  it('runs ONE unit of work as { user, tenant, roles }: `before` first, then the insert; the caller keeps its principal', async () => {
    const user = makeUserRecord();
    const order: string[] = [];
    const caller = createPrincipal({ userId: user.id, tenantId: null });
    sessions.create.mockImplementation(async () => {
      order.push('insert');
      expect(getPrincipal()).toEqual({
        userId: user.id,
        tenantId: TENANT,
        roles: ['owner'],
        staff: false,
      });
    });
    const seen = await runWithPrincipal(caller, async () => {
      await service.open({ user, tenantId: TENANT, roles: ['owner'] }, async () => {
        order.push('before');
        expect(getPrincipal()).toMatchObject({ userId: user.id, tenantId: TENANT });
      });
      return getPrincipal();
    });
    expect(order).toEqual(['before', 'insert']);
    expect(transaction.runs).toBe(1);
    expect(transaction.principals).toEqual([
      { userId: user.id, tenantId: TENANT, roles: ['owner'], staff: false },
    ]);
    expect(seen).toBe(caller);
    // Both tokens are signed before the unit of work opens.
    expect(tokens.issueRefreshToken).toHaveBeenCalledBefore(sessions.create);
  });

  it('openIf: `before` returning false ends the unit of work without a session (null)', async () => {
    const result = await service.openIf(
      { user: makeUserRecord(), tenantId: TENANT, roles: ['member'] },
      async () => false,
    );
    expect(result).toBeNull();
    expect(sessions.create).not.toHaveBeenCalled();
    expect(transaction.runs).toBe(1);
  });

  it('never changes the principal inside an open transaction (real adapter: RLS_CONTEXT_STALE, nothing sent)', async () => {
    const pg = createFakePostgres();
    const host = fakeTransactionHost(pg.db);
    const runner = new DrizzleTransactionRunner(host);
    const real = new SessionTokensService(tokens, new DrizzleSessionsRepository(host), runner);
    const user = makeUserRecord({ id: '0190f3b2-0000-7000-8000-00000000a001' });
    const otherTenant = createPrincipal({
      userId: user.id,
      tenantId: '0190f3b2-0000-7000-8000-0000000000bb',
      roles: ['member'],
    });
    await expect(
      runWithPrincipal(otherTenant, () =>
        runner.run(() => real.open({ user, tenantId: TENANT, roles: ['owner'] })),
      ),
    ).rejects.toMatchObject({ code: 'RLS_CONTEXT_STALE' });
    expect(pg.executed).toEqual([]);

    // The same user in the same tenant joins the caller's transaction (register: one transaction).
    const same = createPrincipal({ userId: user.id, tenantId: TENANT, roles: ['owner'] });
    await runWithPrincipal(same, () =>
      runner.run(() => real.open({ user, tenantId: TENANT, roles: ['owner'] })),
    );
    expect(pg.transactions.filter((entry) => entry === 'begin')).toHaveLength(2);
    expect(pg.executed.map((query) => query.sql.split(' (')[0])).toEqual([
      'insert into "identity"."sessions"',
    ]);
  });

  it("refuses to open a session for a user other than the unit of work's principal (fail closed)", async () => {
    const other = createPrincipal({
      userId: '0190f3b2-0000-7000-8000-00000000beef',
      tenantId: null,
    });
    await expect(
      ClsServiceManager.getClsService().run(() =>
        runWithPrincipal(other, () =>
          service.open({ user: makeUserRecord(), tenantId: TENANT, roles: ['owner'] }),
        ),
      ),
    ).rejects.toBeInstanceOf(UnauthenticatedException);
    expect(transaction.runs).toBe(0);
    expect(tokens.issueRefreshToken).not.toHaveBeenCalled();
  });
});
