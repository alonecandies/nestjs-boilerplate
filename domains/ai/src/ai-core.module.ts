import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiModule } from '@platform/ai';
import { aiConfig } from '@platform/config';
import { CreateConversationHandler } from './application/commands/create-conversation/create-conversation.handler.js';
import { DeleteConversationHandler } from './application/commands/delete-conversation/delete-conversation.handler.js';
import { SendMessageHandler } from './application/commands/send-message/send-message.handler.js';
import { GetConversationHandler } from './application/queries/get-conversation/get-conversation.handler.js';
import { ListConversationsHandler } from './application/queries/list-conversations/list-conversations.handler.js';
import { ListMessagesHandler } from './application/queries/list-messages/list-messages.handler.js';
import { ConversationsRepository } from './application/repositories/conversations.repository.js';
import { MessagesRepository } from './application/repositories/messages.repository.js';
import { UsageRepository } from './application/repositories/usage.repository.js';
import { DrizzleConversationsRepository } from './infrastructure/persistence/drizzle-conversations.repository.js';
import { DrizzleMessagesRepository } from './infrastructure/persistence/drizzle-messages.repository.js';
import { DrizzleUsageRepository } from './infrastructure/persistence/drizzle-usage.repository.js';

/**
 * The ai core: the CQRS handlers of the chat API, the Drizzle repositories (runtime pool, under
 * RLS) and the model client (`AiModule.forRootAsync()`, global `AiClient` over OpenRouter, off
 * while `AI_ENABLED=false`). Imported by the process that owns the ai tables (the monolith now).
 *
 * Expects these global app-level modules: `AppConfigModule`, `CqrsModule.forRoot()` and
 * `DatabaseModule.forRootAsync({ schema: aiSchema, migrations: [aiMigrations] })` (with the other
 * contexts' schema and sets). Tests replace `AiModelProvider` with `MockAiModelProvider`.
 */
@Module({
  imports: [ConfigModule.forFeature(aiConfig), AiModule.forRootAsync()],
  providers: [
    CreateConversationHandler,
    ListConversationsHandler,
    GetConversationHandler,
    DeleteConversationHandler,
    ListMessagesHandler,
    SendMessageHandler,
    { provide: ConversationsRepository, useClass: DrizzleConversationsRepository },
    { provide: MessagesRepository, useClass: DrizzleMessagesRepository },
    { provide: UsageRepository, useClass: DrizzleUsageRepository },
  ],
})
export class AiCoreModule {}
