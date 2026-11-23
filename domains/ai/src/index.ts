/**
 * @domain/ai — the AI bounded context: per-tenant conversations, their messages and a usage log
 * (Drizzle, distributed by tenant on Citus, under row-local RLS), over `@platform/ai`.
 *
 * Wiring: `aiSchema` and the migration set `aiMigrations` go into
 * `DatabaseModule.forRootAsync({ schema, migrations })`; the monolith imports `AiCoreModule`
 * (handlers, repositories, `AiModule`) then `AiApiModule.forLocal()`; ai-service imports
 * `AiGrpcModule` (the core + `ai.v1.AiService`) and the gateway `AiApiModule.forRemote()`. The
 * process that runs the core binds `AiToolSources` (globally) to the owners' ports for the model's
 * read-only tools. In-memory twins and `FakeAiToolSources`:
 * `@domain/ai/testing`.
 */

// The core (handlers, repositories, model client) for the process that owns the ai tables, and
// ai.v1.AiService over it (ai-service).
export { AiCoreModule } from './ai-core.module.js';
export { AiGrpcModule } from './ai-grpc.module.js';
// The edge surface (also `@domain/ai/api`): the API module, port, permission, policy, records.
export * from './api/index.js';
// Application: the persistence ports
export * from './application/repositories/conversations.repository.js';
export * from './application/repositories/messages.repository.js';
export * from './application/repositories/usage.repository.js';
// Application: the chat tools and the sources the app binds to the owners' ports
export { AI_TOOLS_SYSTEM_PROMPT, AiChatTools } from './application/tools/ai-chat-tools.js';
export {
  type AiToolOwnerPorts,
  AiToolSources,
  OwnerPortsAiToolSources,
} from './application/tools/ai-tool-sources.js';
export {
  AI_TOOL_NAMES,
  AI_TOOLS,
  type AiTool,
  type AiToolCaller,
  type AiToolContext,
  AiToolErrorCode,
  AiToolName,
} from './application/tools/ai-tools.js';
// Infrastructure
export { aiMigrations } from './infrastructure/persistence/ai.migrations.js';
export {
  type AiSchema,
  aiSchema,
  type ConversationRow,
  conversations,
  type MessageRow,
  messageRoleEnum,
  messageStatusEnum,
  messages,
  type UsageRow,
  usage,
  usageOutcomeEnum,
} from './infrastructure/persistence/ai.schema.js';
export { DrizzleConversationsRepository } from './infrastructure/persistence/drizzle-conversations.repository.js';
export { DrizzleMessagesRepository } from './infrastructure/persistence/drizzle-messages.repository.js';
export { DrizzleUsageRepository } from './infrastructure/persistence/drizzle-usage.repository.js';
