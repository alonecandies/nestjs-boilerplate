import { join } from 'node:path';
import type { GrpcOptions } from '@nestjs/microservices';
// Value imports on purpose: evaluating the generated modules registers ts-proto's
// google.protobuf.Timestamp <-> Date wrapper on the shared protobufjs instance. Every process that
// builds gRPC options goes through this file, so Timestamps can never silently decode as
// `{ seconds, nanos }` because a service only imported contract *types* (nest-distributed §9.2).
import { BILLING_SERVICE_NAME } from '../generated/billing/v1/billing.pb.js';
import { AUTH_SERVICE_NAME, USERS_SERVICE_NAME } from '../generated/identity/v1/identity.pb.js';
import { NOTIFICATIONS_SERVICE_NAME } from '../generated/notifications/v1/notifications.pb.js';

/**
 * Absolute path of the `.proto` sources. `src/grpc` and `dist/grpc` sit at the same depth and swc
 * `copyFiles` mirrors `src/proto/**` into `dist/proto/**`, so one relative hop resolves to
 * `<pkg>/src/proto` in dev (source condition) and `<pkg>/dist/proto` in production images.
 */
export const PROTO_DIR: string = join(import.meta.dirname, '..', 'proto');

/** Static description of one versioned protobuf package served over gRPC. */
export interface GrpcPackageSpec {
  /** Protobuf `package` (as declared in the .proto file). */
  readonly package: string;
  /** Proto files relative to {@link PROTO_DIR}; proto-loader resolves them through `includeDirs`. */
  readonly protoPath: readonly string[];
  /** Unqualified service names, as used by `@GrpcMethod` and `ClientGrpc.getService()`. */
  readonly services: readonly string[];
  /** DI token of the `ClientGrpc` registered for this package by `GrpcClientsModule`. */
  readonly clientToken: string;
  /**
   * Side-effect-free rpcs (proto method names, by unqualified service): the ONLY methods clients
   * retry automatically on `UNAVAILABLE`. A server can commit a mutation and then die before
   * answering; a replayed `RefreshTokens` would then trip refresh-token reuse detection, a
   * replayed `Register` would fail with `EMAIL_TAKEN`, and so on. Add a method here only if
   * running it twice is harmless.
   */
  readonly idempotentMethods: Readonly<Record<string, readonly string[]>>;
}

/**
 * Registry of every gRPC package in the system — the one place transport code reads package names,
 * proto files and client tokens from. Service names come from the generated code, so renaming a
 * service in a .proto file cannot drift from what servers and clients register.
 */
export const GRPC_PACKAGES = {
  identity: {
    package: 'identity.v1',
    protoPath: ['identity/v1/identity.proto'],
    services: [AUTH_SERVICE_NAME, USERS_SERVICE_NAME],
    clientToken: 'IDENTITY_GRPC_CLIENT',
    // AuthService (Register, Login, RefreshTokens, Logout) is deliberately absent.
    idempotentMethods: { [USERS_SERVICE_NAME]: ['GetUser', 'GetUsersByIds', 'ListUsers'] },
  },
  notifications: {
    package: 'notifications.v1',
    protoPath: ['notifications/v1/notifications.proto'],
    services: [NOTIFICATIONS_SERVICE_NAME],
    clientToken: 'NOTIFICATIONS_GRPC_CLIENT',
    idempotentMethods: { [NOTIFICATIONS_SERVICE_NAME]: ['ListNotifications'] },
  },
  billing: {
    package: 'billing.v1',
    protoPath: ['billing/v1/billing.proto'],
    services: [BILLING_SERVICE_NAME],
    clientToken: 'BILLING_GRPC_CLIENT',
    idempotentMethods: { [BILLING_SERVICE_NAME]: ['ListPayments'] },
  },
} as const satisfies Record<string, GrpcPackageSpec>;

export type GrpcPackageName = keyof typeof GRPC_PACKAGES;

/** Every registered package name (stable declaration order). */
export const GRPC_PACKAGE_NAMES = Object.freeze(
  Object.keys(GRPC_PACKAGES),
) as readonly GrpcPackageName[];

/** Narrows untrusted input (env/config values) to a known package name. */
export function isGrpcPackageName(value: unknown): value is GrpcPackageName {
  return typeof value === 'string' && Object.hasOwn(GRPC_PACKAGES, value);
}

/** proto-loader options accepted by Nest's gRPC transport (`GrpcOptions['options']['loader']`). */
export type GrpcLoaderOptions = NonNullable<GrpcOptions['options']['loader']>;

/**
 * proto-loader options for BOTH servers and clients. They MUST mirror the ts-proto options in
 * `buf.gen.yaml`, otherwise runtime values contradict the generated types:
 * - `keepCase: false` <-> snake_to_camel field names (`display_name` -> `displayName`)
 * - `longs: String`   <-> `forceLong=string` (int64 stays exact beyond 2^53)
 * - `enums: String`   <-> `stringEnums=true`
 * - `defaults: true`  <-> non-optional scalars/arrays are always present. Absent *message* fields
 *   decode as `null` (not `undefined`) — check them with `== null`.
 * - `oneofs: true`    proto3 `optional` fields also get a synthetic `_field` key; map to DTOs
 *   instead of returning decoded objects verbatim.
 */
export const GRPC_LOADER_OPTIONS = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_DIR],
} satisfies GrpcLoaderOptions;

/** Everything a gRPC server/client needs for a set of packages, deduplicated. */
export interface ResolvedGrpcPackages {
  /** Protobuf package names for `GrpcOptions.options.package`. */
  readonly packages: string[];
  /** Proto files (relative to {@link PROTO_DIR}) for `GrpcOptions.options.protoPath`. */
  readonly protoPath: string[];
  /**
   * Fully-qualified service names (`identity.v1.AuthService`): the keys grpc health checking,
   * server reflection and service-config `methodConfig[].name[].service` expect.
   */
  readonly services: string[];
  /**
   * `{ service, method }` names (gRFC A6 `methodConfig[].name[]`) of every idempotent rpc of the
   * packages (`GrpcPackageSpec.idempotentMethods`), with fully-qualified service names.
   */
  readonly idempotentMethods: GrpcMethodName[];
}

/** A fully-qualified service plus a proto method name (`identity.v1.UsersService` / `GetUser`). */
export interface GrpcMethodName {
  readonly service: string;
  readonly method: string;
}

/**
 * Resolves package names into the arrays Nest's `GrpcOptions` and grpc-js service config need.
 * Order follows the input; duplicates are dropped so callers can merge package lists freely.
 */
export function resolveGrpcPackages(names: readonly GrpcPackageName[]): ResolvedGrpcPackages {
  const specs = [...new Set(names)].map((name): GrpcPackageSpec => GRPC_PACKAGES[name]);
  return {
    packages: specs.map((spec) => spec.package),
    protoPath: [...new Set(specs.flatMap((spec) => spec.protoPath))],
    services: specs.flatMap((spec) => spec.services.map((service) => `${spec.package}.${service}`)),
    idempotentMethods: specs.flatMap((spec) =>
      Object.entries(spec.idempotentMethods).flatMap(([service, methods]) =>
        methods.map((method) => ({ service: `${spec.package}.${service}`, method })),
      ),
    ),
  };
}
