import { Role } from '@app/auth';
import { EntityNotFoundException, generateId, provideCommonEnhancers } from '@app/common';
import { AppCacheService, AUTH_THROTTLE_KEY } from '@app/redis';
import { createFastifyTestApp, createMock } from '@app/testing';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_TEST_IMPORTS,
  bearer,
  principal,
  type TestPrincipal,
} from '../../../test/auth-test.module.js';
import { makeAuthTokens, makeUser } from '../../../test/fixtures.js';
import { InMemoryAppCache } from '../../../test/in-memory-app-cache.js';
import { AuthPort } from '../../application/ports/auth.port.js';
import { UsersPort } from '../../application/ports/users.port.js';
import {
  CannotRevokeOwnAdminRoleException,
  EmailAlreadyTakenException,
  InvalidCredentialsException,
} from '../../domain/identity.errors.js';
import { UserReadCache } from '../shared/user-read.cache.js';
import { AuthController } from './auth.controller.js';
import { LocalStrategy } from './strategies/local.strategy.js';
import { UsersController } from './users.controller.js';

type App = Awaited<ReturnType<typeof createFastifyTestApp>>;

const authPort = createMock<AuthPort>();
const usersPort = createMock<UsersPort>();
const cache = new InMemoryAppCache();

describe('identity REST API (Fastify, real JWT guards, fake ports)', () => {
  let app: App;
  let user: TestPrincipal;
  let moderator: TestPrincipal;
  let admin: TestPrincipal;

  beforeAll(async () => {
    const builder = Test.createTestingModule({
      imports: AUTH_TEST_IMPORTS,
      controllers: [AuthController, UsersController],
      providers: [
        LocalStrategy,
        UserReadCache,
        { provide: AuthPort, useValue: authPort },
        { provide: UsersPort, useValue: usersPort },
        { provide: AppCacheService, useValue: cache },
        ...provideCommonEnhancers(),
      ],
    });
    app = await createFastifyTestApp(builder, undefined, { appOptions: { logger: false } });
    [user, moderator, admin] = await Promise.all([
      principal(app, [Role.User]),
      principal(app, [Role.Moderator]),
      principal(app, [Role.Admin]),
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    authPort.register.mockReset();
    authPort.login.mockReset();
    authPort.refreshTokens.mockReset();
    authPort.logout.mockReset();
    usersPort.getUser.mockReset();
    usersPort.listUsers.mockReset();
    usersPort.updateUserRoles.mockReset();
    cache.store.clear();
    cache.loads.length = 0;
  });

  it('credential endpoints use the strict auth throttling window', () => {
    for (const handler of [AuthController.prototype.register, AuthController.prototype.login]) {
      expect(Reflect.getMetadata(AUTH_THROTTLE_KEY, handler)).toBe(true);
    }
  });

  describe('POST /v1/auth/register', () => {
    const body = { email: '  Ada@Example.COM ', password: 'correct horse', displayName: ' Ada ' };

    it('201 (public): normalised input + client fingerprint reach the port; response is allow-listed', async () => {
      const tokens = makeAuthTokens({ user: { ...makeUser(), passwordHash: 'leak' } as never });
      authPort.register.mockResolvedValue(tokens);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: body,
        headers: { 'user-agent': 'vitest' },
      });

      expect(res.statusCode).toBe(201);
      expect(authPort.register).toHaveBeenCalledWith({
        email: 'ada@example.com',
        password: 'correct horse',
        displayName: 'Ada',
        client: expect.objectContaining({ userAgent: 'vitest' }),
      });
      const json = res.json<Record<string, unknown>>();
      expect(json).toMatchObject({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: 900,
        tokenType: 'Bearer',
        user: { id: tokens.user?.id, email: 'ada@example.com', roles: ['user'] },
      });
      expect(json['user']).not.toHaveProperty('passwordHash');
      expect((json['user'] as { createdAt: string }).createdAt).toBe(
        tokens.user?.createdAt?.toISOString(),
      );
    });

    it('400 problem+json with issues for an invalid body (the port is never called)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: 'not-an-email', password: 'short', displayName: '', extra: 1 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toContain('application/problem+json');
      const paths = res.json<{ errors: { path: string }[] }>().errors.map((issue) => issue.path);
      expect(paths).toEqual(expect.arrayContaining(['email', 'password', 'displayName', 'extra']));
      expect(authPort.register).not.toHaveBeenCalled();
    });

    it('409 EMAIL_TAKEN is rendered from the domain exception', async () => {
      authPort.register.mockRejectedValue(new EmailAlreadyTakenException());
      const res = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: body });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
    });
  });

  describe('POST /v1/auth/login (LoginRequestGuard → LocalAuthGuard → LocalStrategy)', () => {
    it('200 with the tokens produced by AuthPort.login (normalised email, client info)', async () => {
      const tokens = makeAuthTokens();
      authPort.login.mockResolvedValue(tokens);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: ' ADA@example.com ', password: 'pw' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ accessToken: tokens.accessToken });
      expect(authPort.login).toHaveBeenCalledWith({
        email: 'ada@example.com',
        password: 'pw',
        client: expect.objectContaining({ ip: expect.any(String) }),
      });
    });

    it('400 (not 401) for an invalid body — validated before passport runs', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'nope' },
      });
      expect(res.statusCode).toBe(400);
      expect(authPort.login).not.toHaveBeenCalled();
    });

    it('401 INVALID_CREDENTIALS passes through LocalAuthGuard unchanged', async () => {
      authPort.login.mockRejectedValue(new InvalidCredentialsException());
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'ada@example.com', password: 'wrong' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    });
  });

  describe('POST /v1/auth/refresh', () => {
    it('200 rotates through the port (public)', async () => {
      authPort.refreshTokens.mockResolvedValue(makeAuthTokens());
      const refreshToken = user.token; // any well-formed JWT
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken },
      });
      expect(res.statusCode).toBe(200);
      expect(authPort.refreshTokens).toHaveBeenCalledWith({
        refreshToken,
        client: expect.any(Object),
      });
    });

    it('400 for something that is not a JWT', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: 'garbage' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /v1/auth/logout', () => {
    it('401 without a bearer token', async () => {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/logout', payload: {} });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'MISSING_TOKEN' });
    });

    it('204: the access token jti/exp and the optional refresh token go to the port', async () => {
      authPort.logout.mockResolvedValue(undefined);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: bearer(user),
      });
      expect(res.statusCode).toBe(204);
      expect(authPort.logout).toHaveBeenCalledWith({
        userId: user.id,
        accessTokenJti: user.jti,
        accessTokenExp: String(user.exp),
        refreshToken: undefined,
      });
    });
  });

  it('GET /v1/auth/me returns the (cached) profile of the caller', async () => {
    usersPort.getUser.mockResolvedValue(makeUser({ id: user.id }));
    const res = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: bearer(user) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: user.id });
    expect(usersPort.getUser).toHaveBeenCalledWith(user.id);
  });

  describe('GET /v1/users', () => {
    it('401 anonymous, 403 for role user (needs users:read)', async () => {
      expect((await app.inject({ method: 'GET', url: '/v1/users' })).statusCode).toBe(401);
      const res = await app.inject({ method: 'GET', url: '/v1/users', headers: bearer(user) });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
    });

    it('200 for a moderator; query string coerced and validated', async () => {
      const listed = makeUser();
      usersPort.listUsers.mockResolvedValue({ items: [listed], nextCursor: 'c2' });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/users?limit=5&search=%20ada%20&cursor=c1',
        headers: bearer(moderator),
      });

      expect(res.statusCode).toBe(200);
      expect(usersPort.listUsers).toHaveBeenCalledWith({ limit: 5, cursor: 'c1', search: 'ada' });
      expect(res.json()).toEqual({
        items: [expect.objectContaining({ id: listed.id })],
        nextCursor: 'c2',
      });
    });

    it('search: < 3 characters → 400 (trigram index); a blank search means no filter', async () => {
      const short = await app.inject({
        method: 'GET',
        url: '/v1/users?search=%20ab%20',
        headers: bearer(admin),
      });
      expect(short.statusCode).toBe(400);

      usersPort.listUsers.mockResolvedValue({ items: [] });
      const blank = await app.inject({
        method: 'GET',
        url: '/v1/users?search=%20%20',
        headers: bearer(admin),
      });
      expect(blank.statusCode).toBe(200);
      expect(usersPort.listUsers).toHaveBeenCalledTimes(1);
      expect(usersPort.listUsers).toHaveBeenCalledWith({
        limit: 20,
        cursor: undefined,
        search: undefined,
      });
    });

    it('400 for limit out of range', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/users?limit=1000',
        headers: bearer(admin),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /v1/users/:id', () => {
    it('400 for a non-uuidv7 id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/users/123e4567-e89b-42d3-a456-426614174000',
        headers: bearer(admin),
      });
      expect(res.statusCode).toBe(400);
    });

    it("a user reads themself (cached for 30 s: one port call), not somebody else's profile", async () => {
      usersPort.getUser.mockResolvedValue(makeUser({ id: user.id }));
      for (let i = 0; i < 2; i += 1) {
        const res = await app.inject({
          method: 'GET',
          url: `/v1/users/${user.id}`,
          headers: bearer(user),
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ id: user.id });
      }
      expect(usersPort.getUser).toHaveBeenCalledOnce();

      const other = await app.inject({
        method: 'GET',
        url: `/v1/users/${admin.id}`,
        headers: bearer(user),
      });
      expect(other.statusCode).toBe(403);
    });

    it('users:read holders read anyone; unknown ids are 404', async () => {
      usersPort.getUser.mockRejectedValue(new EntityNotFoundException('User', admin.id));
      const res = await app.inject({
        method: 'GET',
        url: `/v1/users/${admin.id}`,
        headers: bearer(moderator),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('PATCH /v1/users/:id/roles', () => {
    const target = generateId();

    it('403 for a moderator (needs users:manage-roles)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/users/${target}/roles`,
        headers: bearer(moderator),
        payload: { roles: ['moderator'] },
      });
      expect(res.statusCode).toBe(403);
    });

    it('400 for unknown / duplicate / empty roles', async () => {
      for (const roles of [['root'], ['user', 'user'], []]) {
        const res = await app.inject({
          method: 'PATCH',
          url: `/v1/users/${target}/roles`,
          headers: bearer(admin),
          payload: { roles },
        });
        expect(res.statusCode).toBe(400);
      }
      expect(usersPort.updateUserRoles).not.toHaveBeenCalled();
    });

    it('200 for an admin: actor id from the token, and the cached profile is invalidated', async () => {
      usersPort.getUser.mockResolvedValue(makeUser({ id: target, roles: ['user'] }));
      usersPort.updateUserRoles.mockResolvedValue(makeUser({ id: target, roles: ['moderator'] }));
      await app.inject({ method: 'GET', url: `/v1/users/${target}`, headers: bearer(admin) });
      expect(cache.store.has(`user:${target}`)).toBe(true);

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/users/${target}/roles`,
        headers: bearer(admin),
        payload: { roles: ['moderator'] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: target, roles: ['moderator'] });
      expect(usersPort.updateUserRoles).toHaveBeenCalledWith({
        id: target,
        roles: ['moderator'],
        actorId: admin.id,
      });
      expect(cache.store.has(`user:${target}`)).toBe(false);
    });

    it('422 CANNOT_REVOKE_OWN_ADMIN from the domain', async () => {
      usersPort.updateUserRoles.mockRejectedValue(new CannotRevokeOwnAdminRoleException());
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/users/${admin.id}/roles`,
        headers: bearer(admin),
        payload: { roles: ['user'] },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'CANNOT_REVOKE_OWN_ADMIN' });
    });
  });
});
