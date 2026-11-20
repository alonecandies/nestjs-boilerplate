/**
 * @domain/ai/api — the edge surface of the ai context: `AiApiModule` (REST and GraphQL chat API,
 * SSE and subscription streaming; `forLocal()` for the monolith, `forRemote()` for the gateway with
 * `AiGrpcAdapter` and the `aiGrpcClient` config), the `AiPort` with its request, result and stream
 * shapes, the `ai:chat` permission, the `ai.chat` rate-limit policy config, the chat error codes, the stream
 * wire names (SSE events, the `aiMessageStream` trigger) and the record shapes. No persistence is
 * reachable from here (scripts/check-api-subpaths.mjs).
 */

export { AI_GRPC_UPSTREAM, AI_LIMITS, AiChatErrorCode } from '../ai.constants.js';
export { AI_RBAC, AiPermission } from '../ai.permissions.js';
export { AiApiModule } from '../ai-api.module.js';
export * from '../application/ports/ai.port.js';
export * from '../domain/ai.types.js';
export { AiGrpcAdapter } from '../infrastructure/adapters/grpc/ai-grpc.adapter.js';
export {
  type AiGrpcClientConfig,
  aiGrpcClientConfig,
  aiGrpcClientEnvSchema,
} from '../infrastructure/adapters/grpc/ai-grpc-client.config.js';
export {
  AI_MESSAGE_STREAM_TRIGGER,
  type AiMessageStreamPush,
  aiMessageStreamTrigger,
} from '../presentation/graphql/ai-message-stream.js';
export { AI_SSE_EVENTS, SSE_CONTENT_TYPE } from '../presentation/http/ai-sse.js';
export {
  type AiRateLimitConfig,
  aiRateLimitConfig,
} from '../presentation/rate-limit/ai-rate-limit.config.js';
export { AI_RATE_LIMITS } from '../presentation/rate-limit/ai-rate-limit.js';
