import { generateText } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { AiClient } from './ai.client.js';
import { AiMetrics } from './ai.metrics.js';
import { OpenRouterModelProvider } from './ai-model.provider.js';
import { aiTestConfig } from './testing/index.js';

/** A stub `fetch` answering one OpenAI-style completion: no request leaves the process. */
function stubFetch() {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          id: 'gen-1',
          object: 'chat.completion',
          created: 1,
          model: 'mock/default',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'pong' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10, cost: 0.0002 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
}

describe('OpenRouterModelProvider', () => {
  it('sends the key, the model, usage accounting and the fallback routing list', async () => {
    const fetch = stubFetch();
    const provider = new OpenRouterModelProvider(aiTestConfig(), fetch);

    const result = await generateText({
      model: provider.languageModel('mock/default', ['mock/other']),
      prompt: 'ping',
      maxRetries: 0,
    });

    expect(result.text).toBe('pong');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://openrouter.invalid/api/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer sk-or-v1-test-key-never-sent',
    );
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: 'mock/default',
      models: ['mock/default', 'mock/other'],
      usage: { include: true },
    });
  });

  it('sends no routing list without fallbacks', async () => {
    const fetch = stubFetch();
    const provider = new OpenRouterModelProvider(aiTestConfig(), fetch);

    const model = provider.languageModel('mock/default', []);
    await generateText({ model, prompt: 'ping', maxRetries: 0 });

    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).not.toHaveProperty('models');
  });

  it('reports the token usage and the OpenRouter cost through AiClient', async () => {
    const config = aiTestConfig();
    const client = new AiClient(
      config,
      new OpenRouterModelProvider(config, stubFetch()),
      new AiMetrics(),
    );

    const result = await client.generate({ messages: [{ role: 'user', content: 'ping' }] });

    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 1, costUsd: 0.0002 });
  });
});
