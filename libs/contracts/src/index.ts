/**
 * @platform/contracts — the generic half of the wire contracts. Each domain publishes its own
 * contracts package (`domains/<x>/contracts`, `@domain/<x>-contracts`) built on these types, and
 * `@platform/transport` only ever takes their values:
 * - gRPC: `GrpcPackageSpec` (one per protobuf package), `resolveGrpcPackages` and the
 *   proto-loader options that mirror the shared ts-proto template (`buf.gen.yaml`).
 * - Kafka: `EventContract` (one per topic), the envelope schema with its parse and build helpers,
 *   the topic naming helpers and the record header names.
 * - `@platform/contracts/testing`: wire-format helpers for the contracts packages' specs.
 */
export * from './events/envelope.js';
export * from './events/event-contract.js';
export * from './events/kafka-headers.constants.js';
export * from './events/topics.js';
export * from './grpc/grpc-package-spec.js';
