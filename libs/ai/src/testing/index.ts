/**
 * @platform/ai/testing — mock language models (on the AI SDK's `ai/test` utilities) and a mock
 * `AiModelProvider` for code that depends on `AiClient`. No test calls OpenRouter. Not imported by
 * production code (separate subpath so it never lands in a service's module graph).
 */
export * from './mock-models.js';
