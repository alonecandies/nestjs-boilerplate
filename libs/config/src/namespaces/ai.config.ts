import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zCsv, zInt, zNodeEnv, zStr, zUrl } from '../env/env.helpers.js';
import {
  addKnownLocalSecretIssue,
  isKnownLocalSecret,
  isPublicHttpsUrl,
} from '../env/production-guards.js';

/** The model used when a request names none (an OpenRouter `<vendor>/<model>` id). */
export const AI_DEFAULT_MODEL = 'openai/gpt-4o-mini';

/** OpenRouter model ids: `<vendor>/<model>[:variant]`, e.g. `meta-llama/llama-3.1-8b-instruct:free`. */
export const AI_MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?::[a-z0-9._-]+)?$/i;
const MODEL_ID_MESSAGE = 'Expected an OpenRouter model id: <vendor>/<model>[:variant]';

export const aiEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    // Off by default: nothing calls OpenRouter and the AI routes answer 503 AI_DISABLED.
    AI_ENABLED: zBool(false),
    // Required (and a known placeholder refused in production) only when AI_ENABLED=true.
    OPENROUTER_API_KEY: zStr(),
    OPENROUTER_BASE_URL: zUrl('https://openrouter.ai/api/v1', /^https?$/),
    AI_DEFAULT_MODEL: zStr(AI_DEFAULT_MODEL, {
      pattern: AI_MODEL_ID,
      patternMessage: MODEL_ID_MESSAGE,
    }),
    // Models a request may name; the default model is always allowed.
    AI_ALLOWED_MODELS: zCsv(),
    // OpenRouter `models` routing: tried in order when the requested model fails. Must be allowed.
    AI_FALLBACK_MODELS: zCsv(),
    AI_MAX_OUTPUT_TOKENS: zInt(1_024, { min: 1, max: 32_768 }),
    AI_REQUEST_TIMEOUT_MS: zInt(60_000, { min: 1_000, max: 600_000 }),
    // SDK retries of retryable failures only (429, 5xx, network).
    AI_MAX_RETRIES: zInt(2, { min: 0, max: 5 }),
    // Characters of message text one call may send (history included).
    AI_MAX_INPUT_CHARS: zInt(32_000, { min: 1, max: 1_000_000 }),
    AI_HISTORY_MAX_MESSAGES: zInt(20, { min: 1, max: 200 }),
    // Approximate (characters / 4) token budget of the history window.
    AI_HISTORY_MAX_TOKENS: zInt(8_000, { min: 1, max: 1_000_000 }),
    AI_MAX_TOOL_STEPS: zInt(3, { min: 1, max: 10 }),
    ALLOW_KNOWN_LOCAL_SECRETS: zBool(false),
  })
  .superRefine((env, ctx) => {
    for (const key of ['AI_ALLOWED_MODELS', 'AI_FALLBACK_MODELS'] as const) {
      if (env[key].some((model) => !AI_MODEL_ID.test(model))) {
        ctx.addIssue({ code: 'custom', path: [key], message: MODEL_ID_MESSAGE });
      }
    }
    const allowed = new Set([env.AI_DEFAULT_MODEL, ...env.AI_ALLOWED_MODELS]);
    if (env.AI_FALLBACK_MODELS.some((model) => !allowed.has(model))) {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_FALLBACK_MODELS'],
        message: 'Every fallback model must be AI_DEFAULT_MODEL or listed in AI_ALLOWED_MODELS',
      });
    }
    if (!env.AI_ENABLED) return;
    if (env.OPENROUTER_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENROUTER_API_KEY'],
        message: 'OPENROUTER_API_KEY is required when AI_ENABLED=true',
      });
      return;
    }
    if (env.NODE_ENV !== 'production') return;
    if (!env.ALLOW_KNOWN_LOCAL_SECRETS && isKnownLocalSecret(env.OPENROUTER_API_KEY)) {
      addKnownLocalSecretIssue(ctx, 'OPENROUTER_API_KEY');
    }
    if (!isPublicHttpsUrl(env.OPENROUTER_BASE_URL)) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENROUTER_BASE_URL'],
        message: 'OPENROUTER_BASE_URL must be https on a non-loopback host in production',
      });
    }
  })
  .transform((env) => ({
    enabled: env.AI_ENABLED,
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    defaultModel: env.AI_DEFAULT_MODEL,
    /** The default model first, then AI_ALLOWED_MODELS (de-duplicated). */
    allowedModels: [...new Set([env.AI_DEFAULT_MODEL, ...env.AI_ALLOWED_MODELS])],
    fallbackModels: env.AI_FALLBACK_MODELS,
    maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
    requestTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
    maxRetries: env.AI_MAX_RETRIES,
    maxInputChars: env.AI_MAX_INPUT_CHARS,
    historyMaxMessages: env.AI_HISTORY_MAX_MESSAGES,
    historyMaxTokens: env.AI_HISTORY_MAX_TOKENS,
    maxToolSteps: env.AI_MAX_TOOL_STEPS,
  }));

/** LLM calls through OpenRouter (`@platform/ai`): switch, key, model allowlist and bounds. */
export const aiConfig = defineConfigNamespace('ai', aiEnvSchema);
export type AiConfig = ConfigType<typeof aiConfig>;
