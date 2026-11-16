import { join } from 'node:path';
import {
  boundRpcPatterns,
  loadGrpcPackages,
  protoFilesUnder,
  wireRoundTrip,
} from '@platform/contracts/testing';
import { describe, expect, it } from 'vitest';
import {
  AuthServiceControllerMethods,
  type AuthTokens,
  IDENTITY_GRPC_PACKAGE,
  type ListUsersRequest,
  type LogoutRequest,
  type User,
  type UserPage,
  UsersServiceControllerMethods,
} from '../index.js';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');
const root = loadGrpcPackages([IDENTITY_GRPC_PACKAGE]);

describe('IDENTITY_GRPC_PACKAGE', () => {
  it('resolves its protos under <package>/src/proto and registers every identity proto', () => {
    expect(IDENTITY_GRPC_PACKAGE.protoDir).toBe(join(PACKAGE_ROOT, 'src', 'proto'));
    const own = protoFilesUnder(IDENTITY_GRPC_PACKAGE.protoDir).filter((file) =>
      file.startsWith('identity/'),
    );
    expect(own).toEqual([...IDENTITY_GRPC_PACKAGE.protoPath].sort());
  });

  it('declares the protobuf package and services the proto defines', () => {
    expect(root.lookup('identity.v1')).toBeDefined();
    expect(IDENTITY_GRPC_PACKAGE.services).toEqual(['AuthService', 'UsersService']);
    for (const service of IDENTITY_GRPC_PACKAGE.services) {
      expect(root.lookupService(`identity.v1.${service}`).name).toBe(service);
    }
  });

  it('retries only reads that exist, never a mutation', () => {
    const users = root.lookupService('identity.v1.UsersService');
    const retried = IDENTITY_GRPC_PACKAGE.idempotentMethods['UsersService'] ?? [];
    expect(retried).toEqual(['GetUser', 'GetUsersByIds', 'ListUsers']);
    for (const method of retried) expect(users.methods[method], method).toBeDefined();
    expect(IDENTITY_GRPC_PACKAGE.idempotentMethods['AuthService']).toBeUndefined();
  });

  it.each([
    ['AuthService', AuthServiceControllerMethods],
    ['UsersService', UsersServiceControllerMethods],
  ] as const)('generated %s decorator binds every rpc of the proto', (name, decorator) => {
    const service = root.lookupService(`identity.v1.${name}`);
    expect(boundRpcPatterns(decorator, service)).toEqual(
      service.methodsArray.map((method) => [
        {
          service: name,
          rpc: method.name.charAt(0).toLowerCase() + method.name.slice(1),
          streaming: 'no_stream',
        },
      ]),
    );
  });
});

describe('identity.v1 wire format (proto-loader semantics + generated types)', () => {
  it('round-trips google.protobuf.Timestamp as Date with millisecond precision', () => {
    const user: User = {
      id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      email: 'ada@example.com',
      displayName: 'Ada',
      roles: ['user', 'admin'],
      createdAt: new Date('2026-09-29T10:11:12.345Z'),
      updatedAt: new Date('1999-12-31T23:59:59.999Z'),
    };
    const decoded = wireRoundTrip(root, 'identity.v1.User', user) as unknown as User;
    expect(decoded.createdAt).toBeInstanceOf(Date);
    expect(decoded).toEqual(user);
  });

  it('rejects ISO strings for Timestamp fields (always pass Date)', () => {
    const type = root.lookupType('identity.v1.User');
    expect(() => type.fromObject({ createdAt: '2026-09-29T10:11:12.345Z' })).toThrow(
      /object expected/,
    );
  });

  it('keeps int64 exact as a decimal string', () => {
    const logout: LogoutRequest = {
      userId: 'u1',
      accessTokenJti: 'j1',
      accessTokenExp: '9007199254740993',
    };
    expect(wireRoundTrip(root, 'identity.v1.LogoutRequest', logout)['accessTokenExp']).toBe(
      '9007199254740993',
    );
  });

  it('decodes absent message fields as null and absent optional scalars as missing keys', () => {
    const tokens: AuthTokens = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 900,
      tokenType: 'Bearer',
      tenantId: '0190f3b2-0000-7000-8000-0000000000aa',
      tenantRoles: ['owner'],
    };
    expect(wireRoundTrip(root, 'identity.v1.AuthTokens', tokens)).toEqual({
      ...tokens,
      user: null,
    });
    const lastPage: UserPage = { items: [] };
    const decodedPage = wireRoundTrip(root, 'identity.v1.UserPage', lastPage);
    expect(decodedPage).toEqual({ items: [] });
    expect('nextCursor' in decodedPage).toBe(false);
  });

  it('adds the synthetic oneof key for present proto3 optional fields', () => {
    const request: ListUsersRequest = { limit: 20, cursor: 'abc' };
    expect(wireRoundTrip(root, 'identity.v1.ListUsersRequest', request)).toEqual({
      limit: 20,
      cursor: 'abc',
      _cursor: 'cursor',
    });
  });
});
