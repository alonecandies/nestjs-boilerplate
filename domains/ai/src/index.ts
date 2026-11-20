/**
 * @domain/ai — the AI bounded context: per-tenant conversations, their messages and a usage log
 * (Drizzle, distributed by tenant on Citus, under row-local RLS), over `@platform/ai`.
 *
 * Wiring: `aiSchema` and the migration set `aiMigrations` go into
 * `DatabaseModule.forRootAsync({ schema, migrations })`; the app imports `AiCoreModule` (handlers,
 * repositories, `AiModule`) then `AiApiModule.forLocal()`. In-memory twins: `@domain/ai/testing`.
 */

// The core (handlers, repositories, model client) for the process that owns the ai tables.
export { AiCoreModule } from './ai-core.module.js';
// The edge surface (also `@domain/ai/api`): the API module, port, permission, policy, records.
export * from './api/index.js';
// Application: the persistence ports
export * from './application/repositories/conversations.repository.js';
export * from './application/repositories/messages.repository.js';
export * from './application/repositories/usage.repository.js';
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
