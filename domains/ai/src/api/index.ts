/**
 * @domain/ai/api — the edge surface of the ai context: `AiApiModule` (REST chat API), the `AiPort`
 * with its request and result shapes, the `ai:chat` permission, the `ai.chat` rate-limit policy
 * config, the chat error codes and the record shapes. No persistence is reachable from here
 * (scripts/check-api-subpaths.mjs).
 */

export { AI_LIMITS, AiChatErrorCode } from '../ai.constants.js';
export { AI_RBAC, AiPermission } from '../ai.permissions.js';
export { AiApiModule } from '../ai-api.module.js';
export * from '../application/ports/ai.port.js';
export * from '../domain/ai.types.js';
export {
  type AiRateLimitConfig,
  aiRateLimitConfig,
} from '../presentation/rate-limit/ai-rate-limit.config.js';
export { AI_RATE_LIMITS } from '../presentation/rate-limit/ai-rate-limit.js';
