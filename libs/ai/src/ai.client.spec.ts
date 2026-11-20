import { HttpStatus, Logger } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import type { AiConfig } from '@platform/config';
import { APICallError, jsonSchema, type ModelMessage, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiClient } from './ai.client.js';
import {
  AiDisabledError,
  AiInputTooLargeError,
  AiModelNotAllowedError,
  AiTimeoutError,
  AiUpstreamError,
} from './ai.errors.js';
import { AiMetrics } from './ai.metrics.js';
import {
  aiTestConfig,
  MockAiModelProvider,
  mockFailingModel,
  mockHangingModel,
  mockModelUsage,
  mockStreamModel,
  mockTextModel,
} from './testing/index.js';

const SECRET_PROMPT = 'my private diagnosis is 42-xyzzy';
const ask = (text = 'hello'): ModelMessage[] => [{ role: 'user', content: text }];

const metrics = new AiMetrics();

function setup(model: MockLanguageModelV4, config: Partial<AiConfig> = {}) {
  const provider = new MockAiModelProvider(model);
  const client = new AiClient(aiTestConfig(config), provider, metrics);
  return { client, provider, model };
}

async function value(
  metric: { get(): Promise<{ values: { labels: object; value: number; metricName?: string }[] }> },
  labels: Record<string, string>,
  metricName?: string,
): Promise<number | undefined> {
  const { values } = await metric.get();
  return values.find(
    (entry) =>
      (metricName === undefined || entry.metricName === metricName) &&
      Object.entries(labels).every(
        ([key, v]) => (entry.labels as Record<string, unknown>)[key] === v,
      ),
  )?.value;
}

const upstreamFailure = (message = 'upstream failed'): APICallError =>
  new APICallError({
    message,
    url: 'https://openrouter.invalid/api/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 500,
    isRetryable: false,
  });

beforeEach(() => {
  metrics.requests.reset();
  metrics.tokens.reset();
  metrics.duration.reset();
});

describe('AiClient guards', () => {
  it('refuses while disabled, before asking for any model', async () => {
    const { client, provider, model } = setup(mockTextModel('hi'), { enabled: false });

    const error = await client.generate({ messages: ask() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiDisabledError);
    expect(error).toMatchObject({
      code: 'AI_DISABLED',
      httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
    });
    expect(() => client.stream({ messages: ask() })).toThrow(AiDisabledError);
    expect(provider.requests).toEqual([]);
    expect(model.doGenerateCalls).toEqual([]);
    expect((await metrics.requests.get()).values).toEqual([]);
  });

  it('refuses a model outside the allowlist with 422', async () => {
    const { client, provider } = setup(mockTextModel('hi'));

    const error = await client
      .generate({ messages: ask(), model: 'vendor/expensive' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiModelNotAllowedError);
    expect(error).toMatchObject({
      code: 'AI_MODEL_NOT_ALLOWED',
      httpStatus: HttpStatus.UNPROCESSABLE_ENTITY,
      details: { model: 'vendor/expensive' },
    });
    expect(() => client.stream({ messages: ask(), model: 'vendor/expensive' })).toThrow(
      AiModelNotAllowedError,
    );
    expect(provider.requests).toEqual([]);
  });

  it('refuses input over AI_MAX_INPUT_CHARS', async () => {
    const { client, model } = setup(mockTextModel('hi'), { maxInputChars: 10 });

    await expect(
      client.generate({ messages: [...ask('12345'), ...ask('678901')] }),
    ).rejects.toMatchObject({ code: 'AI_INPUT_TOO_LARGE' });
    await expect(client.generate({ messages: ask('x'.repeat(11)) })).rejects.toBeInstanceOf(
      AiInputTooLargeError,
    );
    expect(model.doGenerateCalls).toEqual([]);
  });

  it('uses the default model, an allowed one on request, and the fallbacks', async () => {
    const { client, provider } = setup(mockTextModel('hi'), {
      fallbackModels: ['mock/other', 'mock/default'],
    });

    await client.generate({ messages: ask() });
    await client.generate({ messages: ask(), model: 'mock/other' });
    expect(provider.requests).toEqual([
      { model: 'mock/default', fallbacks: ['mock/other'] },
      { model: 'mock/other', fallbacks: ['mock/default'] },
    ]);
  });
});

describe('AiClient.generate', () => {
  it('returns the text and usage, and caps the output tokens', async () => {
    const { client, model } = setup(
      mockTextModel('the answer', { inputTokens: 12, outputTokens: 7 }),
    );

    const result = await client.generate({ messages: ask(), maxOutputTokens: 100_000 });
    await client.generate({ messages: ask(), maxOutputTokens: 100 });

    expect(result).toMatchObject({
      model: 'mock/default',
      text: 'the answer',
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 7, costUsd: undefined },
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(model.doGenerateCalls.map((call) => call.maxOutputTokens)).toEqual([256, 100]);
  });

  it('records requests, tokens and duration per model', async () => {
    const { client } = setup(mockTextModel('ok', { inputTokens: 12, outputTokens: 7 }));

    await client.generate({ messages: ask() });

    expect(await value(metrics.requests, { model: 'mock/default', outcome: 'success' })).toBe(1);
    expect(await value(metrics.tokens, { model: 'mock/default', kind: 'input' })).toBe(12);
    expect(await value(metrics.tokens, { model: 'mock/default', kind: 'output' })).toBe(7);
    expect(
      await value(metrics.duration, { model: 'mock/default' }, 'ai_request_duration_seconds_count'),
    ).toBe(1);
  });

  it('aborts the upstream call when the caller signal fires', async () => {
    const model = mockHangingModel();
    const { client } = setup(model);
    const controller = new AbortController();

    const pending = client.generate({ messages: ask(), signal: controller.signal });
    setTimeout(() => controller.abort(), 5);

    await expect(pending).rejects.toThrow();
    await expect(model.aborted).resolves.toBeUndefined();
    expect(await value(metrics.requests, { outcome: 'aborted' })).toBe(1);
  });

  it('times out after AI_REQUEST_TIMEOUT_MS and aborts the upstream call', async () => {
    const model = mockHangingModel();
    const { client } = setup(model, { requestTimeoutMs: 20 });

    const error = await client.generate({ messages: ask() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiTimeoutError);
    expect(error).toMatchObject({ code: 'AI_TIMEOUT', httpStatus: HttpStatus.GATEWAY_TIMEOUT });
    await expect(model.aborted).resolves.toBeUndefined();
    expect(await value(metrics.requests, { outcome: 'timeout' })).toBe(1);
  });

  it('maps an upstream failure to 502 AI_UPSTREAM_ERROR', async () => {
    const { client } = setup(mockFailingModel(upstreamFailure()));

    const error = await client.generate({ messages: ask() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiUpstreamError);
    expect(error).toMatchObject({ code: 'AI_UPSTREAM_ERROR', httpStatus: HttpStatus.BAD_GATEWAY });
    expect(await value(metrics.requests, { outcome: 'error' })).toBe(1);
  });

  it('runs tools up to AI_MAX_TOOL_STEPS steps', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{}' }],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: mockModelUsage({ inputTokens: 3, outputTokens: 2 }),
        warnings: [],
      }),
    });
    const execute = vi.fn(async () => ({ found: true }));
    const { client } = setup(model, { maxToolSteps: 2 });

    const result = await client.generate({
      messages: ask(),
      tools: { lookup: tool({ inputSchema: jsonSchema({ type: 'object' }), execute }) },
    });

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.usage).toMatchObject({ inputTokens: 6, outputTokens: 4 });
  });
});

describe('AiClient.stream', () => {
  const read = async (stream: AsyncIterable<string>): Promise<string[]> => {
    const deltas: string[] = [];
    for await (const delta of stream) deltas.push(delta);
    return deltas;
  };

  it('streams the deltas in order and settles usage and metrics at the end', async () => {
    const { client } = setup(
      mockStreamModel(['Hel', 'lo', '!'], { usage: { inputTokens: 4, outputTokens: 3 } }),
    );

    const call = client.stream({ messages: ask() });

    expect(call.model).toBe('mock/default');
    expect(await read(call.result.textStream)).toEqual(['Hel', 'lo', '!']);
    await expect(call.usage).resolves.toEqual({
      inputTokens: 4,
      outputTokens: 3,
      costUsd: undefined,
    });
    expect(await value(metrics.requests, { outcome: 'success' })).toBe(1);
    expect(await value(metrics.tokens, { kind: 'output' })).toBe(3);
  });

  it('aborts the upstream stream when the caller disconnects mid-stream', async () => {
    const model = mockHangingModel(['partial ']);
    const { client } = setup(model);
    const controller = new AbortController();

    const call = client.stream({ messages: ask(), signal: controller.signal });
    const iterator = call.result.textStream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe('partial ');
    controller.abort();

    await expect(model.aborted).resolves.toBeUndefined();
    await expect(call.usage).rejects.toThrow();
    expect(await value(metrics.requests, { outcome: 'aborted' })).toBe(1);
  });

  it('times out a stream that stalls', async () => {
    const model = mockHangingModel(['partial ']);
    const { client } = setup(model, { requestTimeoutMs: 20 });

    const call = client.stream({ messages: ask() });
    void read(call.result.textStream).catch(() => undefined);

    await expect(call.usage).rejects.toBeInstanceOf(AiTimeoutError);
    await expect(model.aborted).resolves.toBeUndefined();
    expect(await value(metrics.requests, { outcome: 'timeout' })).toBe(1);
  });

  it('rejects usage with AI_UPSTREAM_ERROR when the model fails', async () => {
    const { client } = setup(mockFailingModel(upstreamFailure()));

    const call = client.stream({ messages: ask() });
    void read(call.result.textStream).catch(() => undefined);

    await expect(call.usage).rejects.toBeInstanceOf(AiUpstreamError);
    expect(await value(metrics.requests, { outcome: 'error' })).toBe(1);
  });
});

describe('AiClient privacy', () => {
  it('never puts prompt or completion text in logs or span attributes', async () => {
    const logged: unknown[] = [];
    for (const method of ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }
    for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }
    const attributes: unknown[] = [];
    const span = {
      setAttribute: (key: string, v: unknown) => attributes.push(key, v),
      setAttributes: (attrs: object) => attributes.push(attrs),
      setStatus: (status: unknown) => attributes.push(status),
      recordException: (e: unknown) => attributes.push(e),
      end: () => undefined,
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startSpan: (_name: string, options?: { attributes?: object }) => {
        attributes.push(options?.attributes);
        return span;
      },
    } as never);

    const echo = `I heard: ${SECRET_PROMPT}`;
    await setup(mockTextModel(echo)).client.generate({ messages: ask(SECRET_PROMPT) });
    const streamed = setup(mockStreamModel([echo])).client.stream({ messages: ask(SECRET_PROMPT) });
    for await (const _ of streamed.result.textStream);
    await streamed.usage;
    // An upstream error whose message echoes the prompt.
    await setup(mockFailingModel(upstreamFailure(`bad request: ${SECRET_PROMPT}`)))
      .client.generate({ messages: ask(SECRET_PROMPT) })
      .catch(() => undefined);

    expect(logged.length).toBeGreaterThan(0);
    expect(attributes.length).toBeGreaterThan(0);
    const asText = (entry: unknown): string =>
      entry instanceof Error
        ? `${entry.name}: ${entry.message}\n${entry.stack ?? ''}`
        : typeof entry === 'string'
          ? entry
          : (JSON.stringify(entry) ?? String(entry));
    expect([...logged, ...attributes].map(asText).join('\n')).not.toContain('xyzzy');
  });
});
