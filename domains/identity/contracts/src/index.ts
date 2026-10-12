/**
 * @domain/identity-contracts — the published language of the identity context: the identity.v1
 * gRPC contract (ts-proto NestJS output + `IDENTITY_GRPC_PACKAGE`) and the user-registered event
 * (`USER_REGISTERED_EVENT`). Other domains and the apps depend on this package to talk to
 * identity; only the composition roots import @domain/identity itself.
 *
 * - Generated types are re-exported flat (`User`, `AuthTokens`, …) and as the version-qualified
 *   namespace `identityV1`, the escape hatch for a later `v2`.
 * - Loading this barrel evaluates the generated module, which registers the protobuf
 *   Timestamp <-> Date wrapper (see grpc/identity.grpc-package.ts).
 */
export * from './events/identity.events.js';
export type { Empty } from './generated/google/protobuf/empty.pb.js';
export * from './generated/identity/v1/identity.pb.js';
export * as identityV1 from './generated/identity/v1/identity.pb.js';
export * from './grpc/identity.grpc-package.js';
