import { type INestApplicationContext, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiClient } from './ai.client.js';
import { AiDisabledError } from './ai.errors.js';
import { AiModule } from './ai.module.js';
import { AiModelProvider, OpenRouterModelProvider } from './ai-model.provider.js';
import { MockAiModelProvider, mockTextModel } from './testing/index.js';

describe('AiModule', () => {
  let app: INestApplicationContext | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
  });

  async function boot(provider?: AiModelProvider): Promise<INestApplicationContext> {
    @Module({ imports: [ConfigModule.forRoot({ ignoreEnvFile: true }), AiModule.forRootAsync()] })
    class TestModule {}
    const builder = Test.createTestingModule({ imports: [TestModule] });
    if (provider !== undefined) builder.overrideProvider(AiModelProvider).useValue(provider);
    app = await builder.compile();
    return app;
  }

  it('boots disabled without a key, and every call refuses', async () => {
    vi.stubEnv('AI_ENABLED', 'false');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const ctx = await boot();

    expect(ctx.get(AiModelProvider)).toBeInstanceOf(OpenRouterModelProvider);
    await expect(
      ctx.get(AiClient).generate({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toBeInstanceOf(AiDisabledError);
  });

  it('answers through the configured provider when enabled', async () => {
    vi.stubEnv('AI_ENABLED', 'true');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-v1-test-key-never-sent');
    vi.stubEnv('AI_DEFAULT_MODEL', 'vendor/model-a');
    const provider = new MockAiModelProvider(mockTextModel('hello there'));
    const ctx = await boot(provider);

    const result = await ctx
      .get(AiClient)
      .generate({ messages: [{ role: 'user', content: 'hi' }] });

    expect(result.text).toBe('hello there');
    expect(provider.requests).toEqual([{ model: 'vendor/model-a', fallbacks: [] }]);
  });
});
