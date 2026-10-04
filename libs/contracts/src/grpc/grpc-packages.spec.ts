import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import protobufjs from 'protobufjs';
import { describe, expect, it } from 'vitest';
import {
  AuthServiceControllerMethods,
  type AuthTokens,
  BillingServiceControllerMethods,
  type HandleStripeWebhookRequest,
  type ListUsersRequest,
  type LogoutRequest,
  type Notification,
  NotificationsServiceControllerMethods,
  type Payment,
  type User,
  type UserPage,
  UsersServiceControllerMethods,
} from '../index.js';
import {
  GRPC_LOADER_OPTIONS,
  GRPC_PACKAGE_NAMES,
  GRPC_PACKAGES,
  isGrpcPackageName,
  PROTO_DIR,
  resolveGrpcPackages,
} from './grpc-packages.js';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');
/** Nest's PATTERN_METADATA (not exported from the @nestjs/microservices root). */
const PATTERN_METADATA = 'microservices:pattern';

/**
 * Mirrors @grpc/proto-loader's loadSync + (de)serializers exactly (util.addIncludePathResolver,
 * createSerializer, createDeserializer) on the same protobufjs instance the generated code patches,
 * so these tests exercise the real wire path without depending on proto-loader.
 */
function loadLikeProtoLoader(protoPath: readonly string[]): protobufjs.Root {
  const root = new protobufjs.Root();
  const originalResolvePath = root.resolvePath.bind(root);
  root.resolvePath = (origin, target) => {
    if (isAbsolute(target)) return target;
    for (const dir of GRPC_LOADER_OPTIONS.includeDirs) {
      const candidate = join(dir, target);
      if (existsSync(candidate)) return candidate;
    }
    return originalResolvePath(origin, target);
  };
  root.loadSync([...protoPath], GRPC_LOADER_OPTIONS);
  root.resolveAll();
  return root;
}

const allPackages = resolveGrpcPackages(GRPC_PACKAGE_NAMES);
const root = loadLikeProtoLoader(allPackages.protoPath);

function wireRoundTrip<T extends object>(typeName: string, value: T): Record<string, any> {
  const type = root.lookupType(typeName);
  const bytes = type.encode(type.fromObject(value)).finish();
  return type.toObject(type.decode(bytes), GRPC_LOADER_OPTIONS);
}

function protoFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.proto'))
    .map((file) => file.split('\\').join('/'))
    .sort();
}

describe('PROTO_DIR', () => {
  it('resolves to <pkg>/src/proto when running from sources', () => {
    expect(PROTO_DIR).toBe(join(PACKAGE_ROOT, 'src', 'proto'));
    expect(GRPC_LOADER_OPTIONS.includeDirs).toEqual([PROTO_DIR]);
  });

  it('contains exactly the proto files registered in GRPC_PACKAGES (no orphans)', () => {
    expect(protoFilesUnder(PROTO_DIR)).toEqual([...allPackages.protoPath].sort());
    for (const file of allPackages.protoPath) {
      expect(existsSync(join(PROTO_DIR, file)), file).toBe(true);
    }
  });
});

describe('GRPC_PACKAGES', () => {
  it('exposes the four services with fully-qualified names', () => {
    expect(allPackages.services).toEqual([
      'identity.v1.AuthService',
      'identity.v1.UsersService',
      'notifications.v1.NotificationsService',
      'billing.v1.BillingService',
    ]);
    for (const service of allPackages.services) {
      expect(root.lookupService(service).fullName).toBe(`.${service}`);
    }
  });

  it('declares the protobuf package each proto file actually uses', () => {
    for (const name of GRPC_PACKAGE_NAMES) {
      const spec = GRPC_PACKAGES[name];
      expect(root.lookup(spec.package), spec.package).toBeInstanceOf(protobufjs.Namespace);
    }
  });

  it.each([
    ['identity.v1.AuthService', AuthServiceControllerMethods],
    ['identity.v1.UsersService', UsersServiceControllerMethods],
    ['notifications.v1.NotificationsService', NotificationsServiceControllerMethods],
    ['billing.v1.BillingService', BillingServiceControllerMethods],
  ] as const)('generated %s decorator binds every rpc of the proto', (fullName, decorator) => {
    const service = root.lookupService(fullName);
    const rpcNames = service.methodsArray.map(
      (m) => m.name.charAt(0).toLowerCase() + m.name.slice(1),
    );

    class Controller {}
    for (const name of rpcNames) {
      Object.defineProperty(Controller.prototype, name, {
        value: () => undefined,
        writable: true,
        configurable: true,
      });
    }
    decorator()(Controller);

    const prototype = Controller.prototype as Record<string, object>;
    for (const rpc of rpcNames) {
      const method = prototype[rpc];
      expect(method).toBeTypeOf('function');
      expect(Reflect.getMetadata(PATTERN_METADATA, method as object)).toEqual([
        { service: service.name, rpc, streaming: 'no_stream' },
      ]);
    }
  });
});

describe('resolveGrpcPackages', () => {
  it('keeps input order and drops duplicates', () => {
    expect(resolveGrpcPackages(['billing', 'identity', 'billing'])).toEqual({
      packages: ['billing.v1', 'identity.v1'],
      protoPath: ['billing/v1/billing.proto', 'identity/v1/identity.proto'],
      services: [
        'billing.v1.BillingService',
        'identity.v1.AuthService',
        'identity.v1.UsersService',
      ],
    });
  });

  it('returns empty arrays for no packages', () => {
    expect(resolveGrpcPackages([])).toEqual({ packages: [], protoPath: [], services: [] });
  });

  it('narrows package names', () => {
    expect(GRPC_PACKAGE_NAMES).toEqual(['identity', 'notifications', 'billing']);
    expect(isGrpcPackageName('identity')).toBe(true);
    expect(isGrpcPackageName('toString')).toBe(false);
    expect(isGrpcPackageName(42)).toBe(false);
  });
});

describe('wire format (proto-loader semantics + generated types)', () => {
  it('round-trips google.protobuf.Timestamp as Date with millisecond precision', () => {
    const createdAt = new Date('2026-09-29T10:11:12.345Z');
    const updatedAt = new Date('1999-12-31T23:59:59.999Z');
    const user: User = {
      id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      email: 'ada@example.com',
      displayName: 'Ada',
      roles: ['user', 'admin'],
      createdAt,
      updatedAt,
    };

    const decoded = wireRoundTrip('identity.v1.User', user) as User;

    expect(decoded.createdAt).toBeInstanceOf(Date);
    expect(decoded.createdAt?.toISOString()).toBe(createdAt.toISOString());
    expect(decoded.updatedAt?.toISOString()).toBe(updatedAt.toISOString());
    expect(decoded).toEqual(user);
  });

  it('rejects ISO strings for Timestamp fields (always pass Date)', () => {
    const type = root.lookupType('identity.v1.User');
    expect(() => type.fromObject({ createdAt: '2026-09-29T10:11:12.345Z' })).toThrow(
      /object expected/,
    );
  });

  it('keeps int64 exact as decimal strings beyond 2^53', () => {
    const payment: Payment = {
      id: 'p1',
      userId: 'u1',
      status: 'succeeded',
      amountTotal: '9007199254740993',
      currency: 'usd',
      priceId: 'price_1',
      quantity: 2,
      stripeCheckoutSessionId: 'cs_test_1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:01.000Z'),
    };
    const decoded = wireRoundTrip('billing.v1.Payment', payment) as Payment;
    expect(decoded.amountTotal).toBe('9007199254740993');

    const logout: LogoutRequest = {
      userId: 'u1',
      accessTokenJti: 'j1',
      accessTokenExp: '1790000000',
    };
    expect(
      (wireRoundTrip('identity.v1.LogoutRequest', logout) as LogoutRequest).accessTokenExp,
    ).toBe('1790000000');
  });

  it('decodes absent message fields as null and absent optional scalars as missing keys', () => {
    const tokens: AuthTokens = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 900,
      tokenType: 'Bearer',
    };
    expect(wireRoundTrip('identity.v1.AuthTokens', tokens)).toEqual({ ...tokens, user: null });

    const lastPage: UserPage = { items: [] };
    const decodedPage = wireRoundTrip('identity.v1.UserPage', lastPage);
    expect(decodedPage).toEqual({ items: [] });
    expect('nextCursor' in decodedPage).toBe(false);
  });

  it('adds the synthetic oneof key for present proto3 optional fields', () => {
    const request: ListUsersRequest = { limit: 20, cursor: 'abc' };
    expect(wireRoundTrip('identity.v1.ListUsersRequest', request)).toEqual({
      limit: 20,
      cursor: 'abc',
      _cursor: 'cursor',
    });
  });

  it('round-trips map<string,string> and bytes', () => {
    const notification: Notification = {
      id: 'n1',
      userId: 'u1',
      type: 'welcome',
      title: 'Welcome',
      body: 'Hello',
      read: false,
      data: { link: '/inbox', paymentId: 'p1' },
      createdAt: new Date('2026-05-05T05:05:05.005Z'),
    };
    expect(wireRoundTrip('notifications.v1.Notification', notification)).toEqual(notification);

    const webhook: HandleStripeWebhookRequest = {
      payload: Buffer.from('{"id":"evt_1"}'),
      signature: 't=1,v1=abc',
    };
    const decoded = wireRoundTrip('billing.v1.HandleStripeWebhookRequest', webhook);
    expect(Buffer.isBuffer(decoded.payload)).toBe(true);
    expect((decoded.payload as Buffer).toString('utf8')).toBe('{"id":"evt_1"}');
  });
});
