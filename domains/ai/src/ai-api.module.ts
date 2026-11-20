import { type DynamicModule, Module } from '@nestjs/common';
import { RbacModule } from '@platform/auth';
import { AI_RBAC } from './ai.permissions.js';
import { AiPort } from './application/ports/ai.port.js';
import { AiLocalAdapter } from './infrastructure/adapters/local/ai-local.adapter.js';
import { AiController } from './presentation/http/ai.controller.js';
import { AiRateLimitModule } from './presentation/rate-limit/ai-rate-limit.js';

/**
 * The ai edge: REST `/v1/ai/conversations` (create, list, get, delete, messages, send). The
 * controller only sees `AiPort`.
 *
 * - `forLocal()` (monolith): the port runs on the CQRS buses of `AiCoreModule`, which the app
 *   imports itself.
 *
 * Expects (global): `AuthModule` (JWT, RBAC guards), `AppThrottlerModule` (the `ai.chat` policy)
 * and `provideCommonEnhancers*()` (validation pipes, problem+json).
 */
@Module({})
export class AiApiModule {
  static forLocal(): DynamicModule {
    return {
      module: AiApiModule,
      imports: [AiRateLimitModule, RbacModule.forFeature(AI_RBAC)],
      controllers: [AiController],
      providers: [{ provide: AiPort, useClass: AiLocalAdapter }],
      exports: [AiPort],
    };
  }
}
