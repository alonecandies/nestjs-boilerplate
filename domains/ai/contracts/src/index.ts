/**
 * @domain/ai-contracts — the published language of the ai context: the ai.v1 gRPC contract
 * (ts-proto NestJS output + `AI_GRPC_PACKAGE`). The gateway and ai-service depend on this package
 * to talk to each other; only the composition roots import @domain/ai itself.
 *
 * - Generated types are re-exported flat (`Conversation`, `StreamMessageEvent`, …) and as the
 *   version-qualified namespace `aiV1`, the escape hatch for a later `v2`.
 * - Loading this barrel evaluates the generated module, which registers the protobuf
 *   Timestamp <-> Date wrapper (see grpc/ai.grpc-package.ts).
 */
export * from './generated/ai/v1/ai.pb.js';
export * as aiV1 from './generated/ai/v1/ai.pb.js';
export type { Empty } from './generated/google/protobuf/empty.pb.js';
export * from './grpc/ai.grpc-package.js';
