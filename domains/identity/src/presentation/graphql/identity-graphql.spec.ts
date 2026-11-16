import { Test } from '@nestjs/testing';
import { generateId, provideCommonEnhancers } from '@platform/common';
import { AppGraphqlModule, DataLoaderRegistry } from '@platform/graphql';
import { AppCacheService } from '@platform/redis';
import { createFastifyTestApp } from '@platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
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
  EmailAlreadyTakenException,
  TenantAccessDeniedException,
} from '../../domain/identity.errors.js';
import { USERS_LOADER } from '../../identity.constants.js';
import { UserReadCache } from '../shared/user-read.cache.js';
import { AuthResolver } from './auth.resolver.js';
import { UsersResolver } from './users.resolver.js';
import { UsersLoaderRegistrar } from './users-loader.registrar.js';

type App = Awaited<ReturnType<typeof createFastifyTestApp>>;
interface GqlResponse<T> {
  data?: T | null;
  errors?: { message: string; extensions?: { code?: string; status?: number } }[];
}

/*
 * Plain vi.fn() objects, not @platform/testing's createMock(): its Proxy answers `constructor` with
 * undefined, and @nestjs/graphql's ResolversExplorerService reads metadata off every provider's
 * constructor (TypeError at boot).
 */
type PortFake<T> = { [K in keyof T]: Mock<Extract<T[K], (...args: never[]) => unknown>> };
const authPort: PortFake<AuthPort> = {
  register: vi.fn(),
  login: vi.fn(),
  refreshTokens: vi.fn(),
  logout: vi.fn(),
};
const usersPort: PortFake<UsersPort> = {
  getUser: vi.fn(),
  getUsersByIds: vi.fn(),
  listUsers: vi.fn(),
};

describe('identity GraphQL API (Apollo on Fastify, global guards, fake ports)', () => {
  let app: App;
  let user: TestPrincipal;
  let admin: TestPrincipal;

  const gql = async <T>(
    query: string,
    variables: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<GqlResponse<T>> => {
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json', ...headers },
      payload: { query, variables },
    });
    return res.json<GqlResponse<T>>();
  };

  beforeAll(async () => {
    const builder = Test.createTestingModule({
      imports: [...AUTH_TEST_IMPORTS, AppGraphqlModule.forRootAsync()],
      providers: [
        UsersResolver,
        AuthResolver,
        UsersLoaderRegistrar,
        UserReadCache,
        { provide: AuthPort, useValue: authPort },
        { provide: UsersPort, useValue: usersPort },
        { provide: AppCacheService, useValue: new InMemoryAppCache() },
        ...provideCommonEnhancers(),
      ],
    });
    app = await createFastifyTestApp(builder, undefined, { appOptions: { logger: false } });
    [user, admin] = await Promise.all([principal(app, ['member']), principal(app, ['admin'])]);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    authPort.register.mockReset();
    authPort.login.mockReset();
    usersPort.getUser.mockReset();
    usersPort.getUsersByIds.mockReset();
    usersPort.listUsers.mockReset();
  });

  const USER_FIELDS = 'id email displayName createdAt updatedAt';

  it('register (public): AuthPayload with the user', async () => {
    const tokens = makeAuthTokens({ user: makeUser() });
    authPort.register.mockResolvedValue(tokens);

    const res = await gql<{ register: { accessToken: string; user: { id: string } } }>(
      `mutation($input: RegisterInput!) { register(input: $input) { accessToken expiresIn user { ${USER_FIELDS} } } }`,
      { input: { email: ' Ada@Example.com ', password: 'correct horse', displayName: 'Ada' } },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.register).toMatchObject({
      accessToken: tokens.accessToken,
      user: { id: tokens.user?.id },
    });
    expect(authPort.register).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ada@example.com', password: 'correct horse' }),
    );
  });

  it('input validation errors surface as BAD_REQUEST-class errors; the port is not called', async () => {
    const res = await gql(
      'mutation($input: RegisterInput!) { register(input: $input) { accessToken } }',
      { input: { email: 'nope', password: 'x', displayName: '' } },
    );
    expect(res.data).toBeNull();
    expect(res.errors?.[0]?.extensions?.status).toBe(400);
    expect(authPort.register).not.toHaveBeenCalled();
  });

  it('domain errors keep their code (EMAIL_TAKEN)', async () => {
    authPort.register.mockRejectedValue(new EmailAlreadyTakenException());
    const res = await gql(
      'mutation($input: RegisterInput!) { register(input: $input) { accessToken } }',
      { input: { email: 'ada@example.com', password: 'correct horse', displayName: 'Ada' } },
    );
    expect(res.errors?.[0]?.extensions).toMatchObject({ code: 'EMAIL_TAKEN', status: 409 });
  });

  it('me: 401-class error anonymously, the profile with a token', async () => {
    const anonymous = await gql(`{ me { id } }`);
    expect(anonymous.errors?.[0]?.extensions?.status).toBe(401);

    usersPort.getUser.mockResolvedValue(makeUser({ id: user.id }));
    const res = await gql<{ me: { id: string } }>(`{ me { ${USER_FIELDS} } }`, {}, bearer(user));
    expect(res.data?.me.id).toBe(user.id);
  });

  it('users: FORBIDDEN for role user, a connection for admins', async () => {
    const denied = await gql(`{ users { items { id } } }`, {}, bearer(user));
    expect(denied.errors?.[0]?.extensions).toMatchObject({ code: 'FORBIDDEN', status: 403 });

    const listed = makeUser();
    usersPort.listUsers.mockResolvedValue({ items: [listed] });
    const res = await gql<{
      users: { items: { id: string }[]; nextCursor: null };
    }>(
      `query($limit: Int, $search: String) { users(limit: $limit, search: $search) { items { ${USER_FIELDS} } nextCursor } }`,
      { limit: 5, search: ' ada ' },
      bearer(admin),
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.users).toEqual({
      items: [expect.objectContaining({ id: listed.id })],
      nextCursor: null,
    });
    expect(usersPort.listUsers).toHaveBeenCalledWith({
      limit: 5,
      cursor: undefined,
      search: 'ada',
    });
  });

  it('users(search:) shorter than 3 characters is a 400 validation error', async () => {
    const res = await gql(
      `query($search: String) { users(search: $search) { items { id } } }`,
      { search: ' ab ' },
      bearer(admin),
    );
    expect(res.errors?.[0]?.extensions?.status).toBe(400);
    expect(usersPort.listUsers).not.toHaveBeenCalled();
  });

  it('the schema has no global roles: no User.roles, no enum Role, no updateUserRoles', async () => {
    const body = await gql<{ __type: { fields: { name: string }[] } | null }>(
      '{ __type(name: "User") { fields { name } } }',
    );
    expect(body.data?.__type?.fields.map((field) => field.name)).not.toContain('roles');
    const role = await gql<{ __type: unknown }>('{ __type(name: "Role") { name } }');
    expect(role.data?.__type).toBeNull();
    const mutation = await gql(
      'mutation { updateUserRoles(input: { id: "x", roles: [] }) { id } }',
    );
    expect(mutation.errors?.[0]?.message).toMatch(/updateUserRoles/);
  });

  it('registers the `users` DataLoader: N loads in one operation → ONE getUsersByIds', async () => {
    const [a, b] = [makeUser(), makeUser()];
    usersPort.getUsersByIds.mockResolvedValue([b, a]);
    const loaders = app.get(DataLoaderRegistry).createLoaders();
    // Typed through the `GraphqlLoaders` augmentation shipped by this package.
    const users = loaders[USERS_LOADER];
    const missing = generateId();

    const result = await Promise.all([users.load(a.id), users.load(missing), users.load(b.id)]);

    expect(result).toEqual([a, null, b]);
    expect(usersPort.getUsersByIds).toHaveBeenCalledOnce();
    expect(usersPort.getUsersByIds).toHaveBeenCalledWith([a.id, missing, b.id]);
  });

  it('login(input: { tenantId }) forwards the tenant; a malformed id is a validation error; 403 keeps its code', async () => {
    authPort.login.mockResolvedValue(makeAuthTokens());
    const tenantId = '0190f3b2-0000-7000-8000-0000000000aa';
    const ok = await gql<{ login: { tenantId: string } }>(
      'mutation ($input: LoginInput!) { login(input: $input) { tenantId } }',
      { input: { email: 'ada@example.com', password: 'pw', tenantId } },
    );
    expect(ok.errors).toBeUndefined();
    expect(authPort.login).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ada@example.com', password: 'pw', tenantId }),
    );

    authPort.login.mockClear();
    const malformed = await gql(
      'mutation ($input: LoginInput!) { login(input: $input) { tenantId } }',
      {
        input: { email: 'ada@example.com', password: 'pw', tenantId: 'nope' },
      },
    );
    expect(malformed.errors?.[0]?.extensions?.status).toBe(400);
    expect(authPort.login).not.toHaveBeenCalled();

    authPort.login.mockRejectedValue(new TenantAccessDeniedException());
    const denied = await gql(
      'mutation ($input: LoginInput!) { login(input: $input) { tenantId } }',
      {
        input: { email: 'ada@example.com', password: 'pw', tenantId },
      },
    );
    expect(denied.errors?.[0]?.extensions).toMatchObject({
      code: 'TENANT_ACCESS_DENIED',
      status: 403,
    });
  });
});
