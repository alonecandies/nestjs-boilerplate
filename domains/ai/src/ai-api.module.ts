import { type DynamicModule, Module } from '@nestjs/common';
import { RbacModule } from '@platform/auth';
import { AI_RBAC } from './ai.permissions.js';
import { AiPort } from './application/ports/ai.port.js';
import { AiLocalAdapter } from './infrastructure/adapters/local/ai-local.adapter.js';
import { AiResolver } from './presentation/graphql/ai.resolver.js';
import { AiController } from './presentation/http/ai.controller.js';
import { AiRateLimitModule } from './presentation/rate-limit/ai-rate-limit.js';

/**
 * The ai edge: REST `/v1/ai/conversations` (create, list, get, delete, messages, send, and send
 * streamed as Server-Sent Events) and its GraphQL mirror (`aiConversations`, `aiConversation`,
 * `aiMessages`, `createAiConversation`, `deleteAiConversation`, `sendAiMessage`,
 * `streamAiMessage`, the `aiMessageStream` subscription). Controller and resolver only see `AiPort`.
 *
 * - `forLocal()` (monolith): the port runs on the CQRS buses of `AiCoreModule`, which the app
 *   imports itself.
 *
 * Expects (global): `AuthModule` (JWT, RBAC guards), `AppThrottlerModule` (the `ai.chat` policy),
 * `AppGraphqlModule` + `GraphqlPubSubModule` (the stream subscription) and
 * `provideCommonEnhancers*()` (validation pipes, problem+json).
 */
@Module({})
export class AiApiModule {
  static forLocal(): DynamicModule {
    return {
      module: AiApiModule,
      imports: [AiRateLimitModule, RbacModule.forFeature(AI_RBAC)],
      controllers: [AiController],
      providers: [AiResolver, { provide: AiPort, useClass: AiLocalAdapter }],
      exports: [AiPort],
    };
  }
}
