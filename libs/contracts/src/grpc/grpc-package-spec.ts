import type { GrpcOptions } from '@nestjs/microservices';

/**
 * Static description of one versioned protobuf package served over gRPC. Each domain's contracts
 * package exports one per package (`ORDERS_GRPC_PACKAGE`, …); transport only ever takes these
 * values, never a package name.
 */
export interface GrpcPackageSpec {
  /** Protobuf `package` (as declared in the .proto file). */
  readonly package: string;
  /**
   * Absolute directory `protoPath` is relative to: `<contracts package>/src/proto` from sources,
   * `<contracts package>/dist/proto` after the build (swc `copyFiles`). Transport passes it to
   * proto-loader in `includeDirs`.
   */
  readonly protoDir: string;
  /** Proto files relative to `protoDir`, namespaced by package (`orders/v1/orders.proto`). */
  readonly protoPath: readonly string[];
  /** Unqualified service names, as used by `@GrpcMethod` and `ClientGrpc.getService()`. */
  readonly services: readonly string[];
  /** DI token of the `ClientGrpc` that `GrpcClientsModule.register()` provides for this package. */
  readonly clientToken: string;
  /**
   * Side-effect-free rpcs (proto method names, by unqualified service): the ONLY methods clients
   * retry automatically on `UNAVAILABLE`. A server can commit a mutation and then die before
   * answering; a replayed token refresh would then trip refresh-token reuse detection, a
   * replayed sign-up would fail with a conflict, and so on. Add a method here only if running it
   * twice is harmless.
   */
  readonly idempotentMethods: Readonly<Record<string, readonly string[]>>;
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
 *
 * `includeDirs` is per call: `resolveGrpcPackages(specs).includeDirs`.
 */
export const GRPC_LOADER_OPTIONS = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
} satisfies GrpcLoaderOptions;

/** Everything a gRPC server/client needs for a set of packages, deduplicated. */
export interface ResolvedGrpcPackages {
  /** Protobuf package names for `GrpcOptions.options.package`. */
  readonly packages: string[];
  /** Proto files for `GrpcOptions.options.protoPath`, each relative to one of `includeDirs`. */
  readonly protoPath: string[];
  /** Every package's `protoDir`, for proto-loader's `includeDirs`. */
  readonly includeDirs: string[];
  /**
   * Fully-qualified service names (`orders.v1.OrdersService`): the keys grpc health checking,
   * server reflection and service-config `methodConfig[].name[].service` expect.
   */
  readonly services: string[];
  /**
   * `{ service, method }` names (gRFC A6 `methodConfig[].name[]`) of every idempotent rpc of the
   * packages (`GrpcPackageSpec.idempotentMethods`), with fully-qualified service names.
   */
  readonly idempotentMethods: GrpcMethodName[];
}

/** A fully-qualified service plus a proto method name (`orders.v1.OrdersService` / `GetOrder`). */
export interface GrpcMethodName {
  readonly service: string;
  readonly method: string;
}

/**
 * Resolves package specs into the arrays Nest's `GrpcOptions` and grpc-js service config need.
 * Order follows the input; a package listed twice (same `package`) counts once, so callers can
 * merge lists freely.
 */
export function resolveGrpcPackages(specs: readonly GrpcPackageSpec[]): ResolvedGrpcPackages {
  const byPackage = new Map<string, GrpcPackageSpec>();
  for (const spec of specs) {
    if (!byPackage.has(spec.package)) byPackage.set(spec.package, spec);
  }
  const unique = [...byPackage.values()];
  return {
    packages: unique.map((spec) => spec.package),
    protoPath: [...new Set(unique.flatMap((spec) => spec.protoPath))],
    includeDirs: [...new Set(unique.map((spec) => spec.protoDir))],
    services: unique.flatMap((spec) =>
      spec.services.map((service) => `${spec.package}.${service}`),
    ),
    idempotentMethods: unique.flatMap((spec) =>
      Object.entries(spec.idempotentMethods).flatMap(([service, methods]) =>
        methods.map((method) => ({ service: `${spec.package}.${service}`, method })),
      ),
    ),
  };
}
