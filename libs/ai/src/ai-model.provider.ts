import { createOpenRouter, type OpenRouterProvider } from '@openrouter/ai-sdk-provider';
import type { AiConfig } from '@platform/config';
import type { LanguageModel } from 'ai';

/**
 * Port: builds the AI SDK language model for a model id. `AiClient` asks for one per call, after
 * its guards passed. Tests replace it with `MockAiModelProvider` (`@platform/ai/testing`).
 */
export abstract class AiModelProvider {
  /** `fallbacks`: models to try in order when `model` fails (never contains `model`). */
  abstract languageModel(model: string, fallbacks: readonly string[]): LanguageModel;
}

/**
 * OpenRouter through `@openrouter/ai-sdk-provider`. The provider (and its key) is created on the
 * first call, so a disabled configuration never builds one. Usage accounting is requested so the
 * response carries the cost; fallbacks become OpenRouter's `models` routing list.
 */
export class OpenRouterModelProvider extends AiModelProvider {
  private provider: OpenRouterProvider | undefined;

  constructor(
    private readonly config: AiConfig,
    /** Test seam: the HTTP client (default: the global `fetch`). */
    private readonly fetchImpl?: typeof fetch,
  ) {
    super();
  }

  override languageModel(model: string, fallbacks: readonly string[]): LanguageModel {
    this.provider ??= createOpenRouter({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl,
      compatibility: 'strict',
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
    });
    return this.provider.chat(model, {
      usage: { include: true },
      ...(fallbacks.length === 0 ? {} : { models: [model, ...fallbacks] }),
    });
  }
}
