import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { type AiConfig, aiConfig } from '@platform/config';
import { AiClient } from './ai.client.js';
import { AiMetrics } from './ai.metrics.js';
import { AiModelProvider, OpenRouterModelProvider } from './ai-model.provider.js';

/**
 * Global `AiClient` over OpenRouter, configured by the `ai` namespace. Boots without a key while
 * `AI_ENABLED=false` (every call then throws `AiDisabledError`). Tests override `AiModelProvider`
 * with `MockAiModelProvider` from `@platform/ai/testing`.
 */
@Module({})
export class AiModule {
  static forRootAsync(): DynamicModule {
    return {
      module: AiModule,
      global: true,
      imports: [ConfigModule.forFeature(aiConfig)],
      providers: [
        {
          provide: AiModelProvider,
          inject: [aiConfig.KEY],
          useFactory: (config: AiConfig): AiModelProvider => new OpenRouterModelProvider(config),
        },
        AiMetrics,
        AiClient,
      ],
      exports: [AiClient],
    };
  }
}
