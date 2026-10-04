/**
 * @app/contracts — the wire contracts between services: gRPC (protobuf, ts-proto generated) and
 * Kafka integration events (zod-validated envelopes).
 *
 * Barrel layout:
 * - Generated gRPC types are re-exported FLAT (`import type { User, AuthServiceController } from
 *   '@app/contracts'`). This is collision-free because buf.gen.yaml sets `exportCommonSymbols=false`
 *   (drops each file's `protobufPackage` / `<PKG>_PACKAGE_NAME` constants) and message/service names
 *   are unique across packages — tsc rejects any future clash between these star exports.
 * - The same modules are ALSO exported as version-qualified namespaces (`identityV1.User`), the
 *   escape hatch once a `v2` package with the same message names is introduced.
 * - Loading this barrel evaluates the generated modules, which registers the protobuf
 *   Timestamp <-> Date wrapper (see grpc/grpc-packages.ts).
 */

export * from './events/billing.events.js';
export * from './events/envelope.js';
export * from './events/event-registry.js';
export * from './events/identity.events.js';
export * from './events/kafka-headers.constants.js';
export * from './events/notifications.events.js';
export * from './events/topics.js';
export * from './generated/billing/v1/billing.pb.js';
export * as billingV1 from './generated/billing/v1/billing.pb.js';
export type { Empty } from './generated/google/protobuf/empty.pb.js';
export * from './generated/identity/v1/identity.pb.js';
export * as identityV1 from './generated/identity/v1/identity.pb.js';
export * from './generated/notifications/v1/notifications.pb.js';
export * as notificationsV1 from './generated/notifications/v1/notifications.pb.js';
export * from './grpc/grpc-packages.js';
