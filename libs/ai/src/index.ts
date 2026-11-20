/**
 * @platform/ai — language-model calls through OpenRouter on the Vercel AI SDK: `AiModule` /
 * `AiClient` with the `ai` config namespace (on/off switch, model allowlist, output, input and
 * time bounds), cancellation, metrics and spans without content. Names no domain.
 * Test doubles: `@platform/ai/testing`.
 */
export * from './ai.client.js';
export * from './ai.errors.js';
export * from './ai.metrics.js';
export * from './ai.module.js';
export * from './ai.types.js';
export * from './ai-model.provider.js';
