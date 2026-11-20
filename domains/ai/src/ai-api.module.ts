import { AI_GRPC_PACKAGE } from '@domain/ai-contracts';
import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RbacModule } from '@platform/auth';
import { GrpcClientsModule } from '@platform/transport';
import { AI_RBAC } from './ai.permissions.js';
import { AiPort } from './application/ports/ai.port.js';
import {
  AiGrpcAdapter,
  isAiServiceAnswer,
} from './infrastructure/adapters/grpc/ai-grpc.adapter.js';
import { aiGrpcClientConfig } from './infrastructure/adapters/grpc/ai-grpc-client.config.js';
import { AiLocalAdapter } from './infrastructure/adapters/local/ai-local.adapter.js';
import { AiResolver } from './presentation/graphql/ai.resolver.js';
import { AiController } from './presentation/http/ai.controller.js';
import { AiRateLimitModule } from './presentation/rate-limit/ai-rate-limit.js';

const presentation = (
  adapter: Type<AiPort>,
): Pick<DynamicModule, 'controllers' | 'providers' | 'exports'> => {
  const port: Provider = { provide: AiPort, useClass: adapter };
  return {
    controllers: [AiController],
    providers: [AiResolver, port],
    exports: [AiPort],
  };
};

/**
 * The ai edge: REST `/v1/ai/conversations` (create, list, get, delete, messages, send, and send
 * streamed as Server-Sent Events) and its GraphQL mirror (`aiConversations`, `aiConversation`,
 * `aiMessages`, `createAiConversation`, `deleteAiConversation`, `sendAiMessage`,
 * `streamAiMessage`, the `aiMessageStream` subscription). Controller and resolver only see `AiPort`;
 * the presentation is identical in both topologies, only the binding differs:
 *
 * - `forLocal()` (monolith): the port runs on the CQRS buses of `AiCoreModule`, which the app
 *   imports itself.
 * - `forRemote()` (gateway): the port calls `ai.v1.AiService` of ai-service over gRPC (deadline,
 *   circuit breaker, the caller's principal in metadata; a chat turn streamed server-side).
 *
 * Expects (global): `AuthModule` (JWT, RBAC guards), `AppThrottlerModule` (the `ai.chat` policy,
 * charged here at the edge in both topologies), `AppGraphqlModule` + `GraphqlPubSubModule` (the
 * stream subscription) and `provideCommonEnhancers*()` (validation pipes, problem+json).
 */
@Module({})
export class AiApiModule {
  static forLocal(): DynamicModule {
    return {
      module: AiApiModule,
      imports: [AiRateLimitModule, RbacModule.forFeature(AI_RBAC)],
      ...presentation(AiLocalAdapter),
    };
  }

  /**
   * Gateway: the port → `ai.v1.AiService` over gRPC. The client URL (`AI_GRPC_URL`) and the chat
   * deadline (`AI_GRPC_CHAT_DEADLINE_MS`, also the channel's service-config deadline, so a long
   * streamed turn is not cut by `GRPC_DEADLINE_MS`) are read when `forRemote()` is called.
   */
  static forRemote(): DynamicModule {
    // Read when the module is defined: a client target cannot come from DI.
    const client = aiGrpcClientConfig.parse();
    const grpc = GrpcClientsModule.register(
      { spec: AI_GRPC_PACKAGE, url: client.url },
      {
        client: { deadlineMs: client.chatDeadlineMs },
        breaker: { errorFilter: isAiServiceAnswer },
      },
    );
    return {
      module: AiApiModule,
      imports: [
        grpc,
        ConfigModule.forFeature(aiGrpcClientConfig),
        AiRateLimitModule,
        RbacModule.forFeature(AI_RBAC),
      ],
      ...presentation(AiGrpcAdapter),
    };
  }
}
