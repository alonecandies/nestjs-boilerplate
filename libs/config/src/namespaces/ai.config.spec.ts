import { describe, expect, it } from 'vitest';
import { errorOf } from '../../test/error-of.js';
import { validateAllEnv } from '../all-config.js';
import { AI_DEFAULT_MODEL, aiConfig } from './ai.config.js';

const PROD = { NODE_ENV: 'production' } as const;
const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const ON = { AI_ENABLED: 'true', OPENROUTER_API_KEY: KEY } as const;

const issueKeys = (env: Record<string, string>): unknown[] =>
  errorOf(() => aiConfig.parse(env)).issues.map((issue) => issue.path[0]);

describe('ai config', () => {
  it('is off by default and needs nothing else', () => {
    expect(aiConfig.parse({})).toEqual({
      enabled: false,
      apiKey: undefined,
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: AI_DEFAULT_MODEL,
      allowedModels: [AI_DEFAULT_MODEL],
      fallbackModels: [],
      maxOutputTokens: 1_024,
      requestTimeoutMs: 60_000,
      maxRetries: 2,
      maxInputChars: 32_000,
      historyMaxMessages: 20,
      historyMaxTokens: 8_000,
      maxToolSteps: 3,
    });
    expect(validateAllEnv({}).ai.enabled).toBe(false);
  });

  it('parses the allowlist and always allows the default model', () => {
    const config = aiConfig.parse({
      ...ON,
      AI_DEFAULT_MODEL: 'openai/gpt-4o-mini',
      AI_ALLOWED_MODELS: ' anthropic/claude-3.5-haiku, meta-llama/llama-3.1-8b-instruct:free ,',
      AI_FALLBACK_MODELS: 'anthropic/claude-3.5-haiku',
    });
    expect(config.allowedModels).toEqual([
      'openai/gpt-4o-mini',
      'anthropic/claude-3.5-haiku',
      'meta-llama/llama-3.1-8b-instruct:free',
    ]);
    expect(config.fallbackModels).toEqual(['anthropic/claude-3.5-haiku']);
  });

  it.each([
    ['AI_DEFAULT_MODEL', 'gpt-4o'],
    ['AI_ALLOWED_MODELS', 'openai/gpt-4o,not a model'],
    ['AI_FALLBACK_MODELS', 'openai/gpt-4o'],
  ])('rejects %s=%s (bad id, or a fallback outside the allowlist)', (key, value) => {
    expect(issueKeys({ [key]: value })).toContain(key);
  });

  it.each([
    ['AI_MAX_OUTPUT_TOKENS', '0'],
    ['AI_MAX_OUTPUT_TOKENS', '100000'],
    ['AI_REQUEST_TIMEOUT_MS', '999'],
    ['AI_REQUEST_TIMEOUT_MS', '600001'],
    ['AI_MAX_RETRIES', '6'],
    ['AI_MAX_INPUT_CHARS', '0'],
    ['AI_HISTORY_MAX_MESSAGES', '0'],
    ['AI_HISTORY_MAX_TOKENS', '0'],
    ['AI_MAX_TOOL_STEPS', '11'],
  ])('bounds %s (rejects %s)', (key, value) => {
    expect(issueKeys({ [key]: value })).toContain(key);
  });

  it('accepts the bounds themselves', () => {
    const config = aiConfig.parse({
      AI_MAX_OUTPUT_TOKENS: '32768',
      AI_REQUEST_TIMEOUT_MS: '1000',
      AI_MAX_RETRIES: '0',
      AI_MAX_TOOL_STEPS: '1',
    });
    expect(config).toMatchObject({
      maxOutputTokens: 32_768,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      maxToolSteps: 1,
    });
  });

  it('requires OPENROUTER_API_KEY only when enabled', () => {
    expect(issueKeys({ AI_ENABLED: 'true' })).toEqual(['OPENROUTER_API_KEY']);
    expect(aiConfig.parse(ON)).toMatchObject({ enabled: true, apiKey: KEY });
    expect(() => aiConfig.parse({ ...PROD, AI_ENABLED: 'false' })).not.toThrow();
  });

  describe('production guards', () => {
    it.each(['sk-or-v1-...', '<your-openrouter-key>', 'openrouter-placeholder-key', 'change-me'])(
      'refuses the known placeholder key %s when enabled, without echoing it',
      (placeholder) => {
        const error = errorOf(() =>
          aiConfig.parse({ ...PROD, ...ON, OPENROUTER_API_KEY: placeholder }),
        );
        expect(error.issues.map((issue) => issue.path[0])).toEqual(['OPENROUTER_API_KEY']);
        expect(error.message).not.toContain(placeholder);
      },
    );

    it('refuses a plaintext or loopback base URL when enabled', () => {
      expect(
        issueKeys({ ...PROD, ...ON, OPENROUTER_BASE_URL: 'http://localhost:8080/api/v1' }),
      ).toEqual(['OPENROUTER_BASE_URL']);
    });

    it('accepts a real key, and the explicit local opt-out', () => {
      expect(() => aiConfig.parse({ ...PROD, ...ON })).not.toThrow();
      expect(() =>
        aiConfig.parse({
          ...PROD,
          ...ON,
          OPENROUTER_API_KEY: 'placeholder',
          ALLOW_KNOWN_LOCAL_SECRETS: 'true',
        }),
      ).not.toThrow();
    });

    it('does not check a disabled configuration', () => {
      expect(() => aiConfig.parse({ ...PROD, OPENROUTER_API_KEY: 'placeholder' })).not.toThrow();
    });
  });
});
