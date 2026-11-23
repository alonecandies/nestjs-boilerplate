import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { HttpStatus, Logger } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import type { AiConfig } from '@platform/config';
import { APICallError, jsonSchema, type ModelMessage, simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiClient, aiInputChars, aiUsageOf } from './ai.client.js';
import {
  AiDisabledError,
  AiInputTooLargeError,
  AiModelNotAllowedError,
  AiTimeoutError,
  AiUpstreamError,
} from './ai.errors.js';
import { AiMetrics } from './ai.metrics.js';
import type { AiCallInput, AiUsage } from './ai.types.js';
import {
  aiTestConfig,
  MockAiModelProvider,
  type MockModelCall,
  type MockModelTurn,
  mockFailingModel,
  mockHangingModel,
  mockModelUsage,
  mockScriptedModel,
  mockStreamModel,
  mockTextModel,
} from './testing/index.js';

const SECRET_PROMPT = 'my private diagnosis is 42-xyzzy';
const ask = (text = 'hello'): ModelMessage[] => [{ role: 'user', content: text }];

const read = async (stream: AsyncIterable<string>): Promise<string[]> => {
  const deltas: string[] = [];
  for await (const delta of stream) deltas.push(delta);
  return deltas;
};

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

function lookupTool() {
  const execute = vi.fn(async () => ({ found: true }));
  return {
    execute,
    tools: { lookup: tool({ inputSchema: jsonSchema({ type: 'object' }), execute }) },
  };
}

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

  it('measures the input with aiInputChars, the export a caller trims its history with', async () => {
    const call = { type: 'tool-call', toolCallId: 'c-1', toolName: 'lookup', input: { q: 'x' } };
    const result = {
      type: 'tool-result',
      toolCallId: 'c-1',
      toolName: 'lookup',
      output: { type: 'json', value: { found: true } },
    };
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, call] },
      { role: 'tool', content: [result] },
    ] as ModelMessage[];
    const system = 'Be brief.';
    // The instructions and text by length, every other part as its JSON.
    const chars = aiInputChars(messages, system);
    expect(chars).toBe(
      system.length +
        'hello'.length +
        'Looking.'.length +
        JSON.stringify(call).length +
        JSON.stringify(result).length,
    );
    expect(aiInputChars(messages)).toBe(chars - system.length);

    // The guard counts the same: at the cap the call goes through, one character less refuses it.
    const atCap = setup(mockTextModel('ok'), { maxInputChars: chars });
    await expect(atCap.client.generate({ messages, system })).resolves.toMatchObject({
      text: 'ok',
    });
    const under = setup(mockTextModel('ok'), { maxInputChars: chars - 1 });
    await expect(under.client.generate({ messages, system })).rejects.toBeInstanceOf(
      AiInputTooLargeError,
    );
    expect(() => under.client.stream({ messages, system })).toThrow(AiInputTooLargeError);
    expect(under.model.doGenerateCalls).toEqual([]);
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
});

describe('AiClient.stream', () => {
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

  it('settles usage at once when the caller signal is already aborted', async () => {
    const model = mockHangingModel(['never ']);
    const { client } = setup(model);
    const controller = new AbortController();
    const reason = new Error('client gone');
    controller.abort(reason);

    const call = client.stream({ messages: ask(), signal: controller.signal });
    const deltas = read(call.result.textStream).catch(() => []);

    const settled = await Promise.race([
      call.usage.then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 1_000)),
    ]);
    expect(settled).toBe(reason);
    expect(await deltas).toEqual([]);
    expect(await value(metrics.requests, { outcome: 'aborted' })).toBe(1);
  });

  it('settles usage when the SDK ends the stream on its abort path', async () => {
    const model = mockHangingModel(['partial ']);
    // A signal aborted without an 'abort' event reaching the client's listener: only the
    // SDK's onAbort path can settle usage. The client's listener is the first one registered
    // on the signal the SDK hands the model (the others sit on the caller's and the deadline's).
    const controller = new AbortController();
    const { client } = setup(model);
    const registered: { target: AbortSignal; listener: unknown }[] = [];
    const original = AbortSignal.prototype.addEventListener;
    const addEventListener = vi
      .spyOn(AbortSignal.prototype, 'addEventListener')
      .mockImplementation(function (this: AbortSignal, ...args: Parameters<typeof original>) {
        if (args[0] === 'abort') registered.push({ target: this, listener: args[1] });
        original.apply(this, args);
      });

    const call = client.stream({ messages: ask(), signal: controller.signal });
    addEventListener.mockRestore();
    const iterator = call.result.textStream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe('partial ');
    const modelSignal = model.doStreamCalls[0]?.abortSignal;
    const clientListener = registered.find(({ target }) => target === modelSignal);
    expect(clientListener).toBeDefined();
    modelSignal?.removeEventListener(
      'abort',
      clientListener?.listener as Parameters<AbortSignal['removeEventListener']>[1],
    );
    controller.abort();
    await iterator.next().catch(() => undefined);

    const settled = await Promise.race([
      call.usage.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 1_000)),
    ]);
    expect(settled).toBe('rejected');
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

  it.each([
    ['a plain', () => new AbortController().signal],
    [
      'the handler-shaped composite',
      () => AbortSignal.any([new AbortController().signal, new AbortController().signal]),
    ],
  ])(
    'stream: a finished call with %s caller signal can be garbage-collected',
    async (_shape, callerSignal) => {
      // Each call gets its own model: a shared mock records every call's options, signal included.
      const client = new AiClient(
        aiTestConfig(),
        new MockAiModelProvider(() => mockStreamModel(['a'])),
        metrics,
      );
      const finished = async (): Promise<WeakRef<Promise<AiUsage>>> => {
        const call = client.stream({ messages: ask(), signal: callerSignal() });
        expect(await read(call.result.textStream)).toEqual(['a']);
        await call.usage;
        return new WeakRef(call.usage);
      };
      const refs: WeakRef<Promise<AiUsage>>[] = [];
      for (let i = 0; i < 20; i += 1) refs.push(await finished());

      // Full GCs across macrotasks: a composite signal is freed by a GC, Node's
      // FinalizationRegistry cleanup, then another GC. Deref only in a later task than the
      // last gc(): a deref in the same task as a gc() keeps its target alive for that task.
      const gc = exposedGc();
      for (let round = 0; round < 6; round += 1) {
        gc();
        await sleep(20);
      }
      await sleep(20);

      expect(refs.filter((ref) => ref.deref() !== undefined)).toHaveLength(0);
    },
  );
});

/** The V8 `gc()`, without a vitest config change (`--expose-gc` set at runtime). */
function exposedGc(): () => void {
  setFlagsFromString('--expose-gc');
  return runInNewContext('gc') as () => void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('AiClient tool steps', () => {
  const STEP_USAGE = { inputTokens: 3, outputTokens: 2 };
  const STEP_COST = 0.25;

  /** Calls `lookup` on every step it may; answers `answer` on a step whose tool choice is none. */
  const toolEveryStep = (answer: string) =>
    mockScriptedModel([
      (call: MockModelCall): MockModelTurn =>
        call.toolChoice?.type === 'none'
          ? { text: answer, usage: STEP_USAGE, costUsd: STEP_COST }
          : {
              toolCalls: [{ toolName: 'lookup', input: {} }],
              usage: STEP_USAGE,
              costUsd: STEP_COST,
            },
    ]);

  it.each(['generate', 'stream'] as const)(
    'the last of AI_MAX_TOOL_STEPS steps answers in text: tools listed, tool choice none (%s)',
    async (kind) => {
      const model = toolEveryStep('Found it.');
      const { client } = setup(model, { maxToolSteps: 3 });
      const { execute, tools } = lookupTool();

      let text: string;
      let usage: AiUsage;
      if (kind === 'generate') {
        ({ text, usage } = await client.generate({ messages: ask(), tools }));
      } else {
        const call = client.stream({ messages: ask(), tools });
        expect(await read(call.result.textStream)).toEqual(['Found it.']);
        usage = await call.usage;
        text = await call.result.text;
      }

      expect(text).toBe('Found it.');
      const calls = kind === 'generate' ? model.doGenerateCalls : model.doStreamCalls;
      expect(calls.map((call) => call.toolChoice)).toEqual([
        { type: 'auto' },
        { type: 'auto' },
        { type: 'none' },
      ]);
      for (const call of calls) expect(call.tools?.map((t) => t.name)).toEqual(['lookup']);
      expect(execute).toHaveBeenCalledTimes(2);
      // Summed over the three steps, and counted once in the metrics (no metered copy added).
      expect(usage).toEqual({ inputTokens: 9, outputTokens: 6, costUsd: 3 * STEP_COST });
      expect(await value(metrics.tokens, { kind: 'input' })).toBe(9);
      expect(await value(metrics.tokens, { kind: 'output' })).toBe(6);
      expect(await value(metrics.requests, { outcome: 'success' })).toBe(1);
    },
  );

  it('with AI_MAX_TOOL_STEPS=1 the only step answers and no tool runs', async () => {
    const model = toolEveryStep('Straight answer.');
    const { client } = setup(model, { maxToolSteps: 1 });
    const { execute, tools } = lookupTool();

    const result = await client.generate({ messages: ask(), tools });

    expect(result.text).toBe('Straight answer.');
    expect(model.doGenerateCalls.map((call) => call.toolChoice)).toEqual([{ type: 'none' }]);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['generate', 'stream'] as const)(
    'a model that calls a tool on the last step anyway fails with AI_UPSTREAM_ERROR (%s)',
    async (kind) => {
      const model = mockScriptedModel([{ toolCalls: [{ toolName: 'lookup', input: {} }] }]);
      const { client } = setup(model, { maxToolSteps: 2 });
      const { execute, tools } = lookupTool();

      let outcome: unknown;
      if (kind === 'generate') {
        outcome = await client.generate({ messages: ask(), tools }).catch((e: unknown) => e);
      } else {
        const call = client.stream({ messages: ask(), tools });
        void read(call.result.textStream).catch(() => undefined);
        outcome = await call.usage.catch((e: unknown) => e);
      }

      // Never an answer without text: the call fails as a bad upstream response.
      expect(outcome).toBeInstanceOf(AiUpstreamError);
      expect(outcome).toMatchObject({
        code: 'AI_UPSTREAM_ERROR',
        httpStatus: HttpStatus.BAD_GATEWAY,
      });
      // The first step's tool call ran; the last step's never does.
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await value(metrics.requests, { outcome: 'error' })).toBe(1);
    },
  );
});

describe('AiClient usage of a failed call (aiUsageOf)', () => {
  /** One billed model call: 1000 tokens in, 50 out, 0.01 USD (OpenRouter usage accounting). */
  const BILLED = { usage: { inputTokens: 1_000, outputTokens: 50 }, costUsd: 0.01 } as const;
  const LOOKUP = { toolName: 'lookup', input: {} } as const;
  const KINDS = ['generate', 'stream'] as const;
  type StreamPart =
    Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P>
      ? P
      : never;

  /** How the call failed: generate's throw, or stream's `usage` rejection once its text ended. */
  async function failureOf(
    kind: (typeof KINDS)[number],
    client: AiClient,
    input: AiCallInput,
  ): Promise<unknown> {
    if (kind === 'generate') {
      return client.generate(input).then(
        () => 'resolved',
        (error: unknown) => error,
      );
    }
    const call = client.stream(input);
    await read(call.result.textStream).catch(() => undefined);
    return call.usage.then(
      () => 'resolved',
      (error: unknown) => error,
    );
  }

  const tokens = async () => ({
    input: await value(metrics.tokens, { kind: 'input' }),
    output: await value(metrics.tokens, { kind: 'output' }),
  });

  it.each(KINDS)(
    'a model that calls a tool on the last step anyway: the 502 carries its three billed calls (%s)',
    async (kind) => {
      // A tool call on every step, the last one (tool choice none) too: three calls, all billed.
      const model = mockScriptedModel([{ toolCalls: [LOOKUP], ...BILLED }]);
      const { client } = setup(model, { maxToolSteps: 3 });

      const error = await failureOf(kind, client, { messages: ask(), tools: lookupTool().tools });

      expect(error).toBeInstanceOf(AiUpstreamError);
      expect(error).toMatchObject({ httpStatus: HttpStatus.BAD_GATEWAY });
      expect(kind === 'generate' ? model.doGenerateCalls : model.doStreamCalls).toHaveLength(3);
      expect(aiUsageOf(error)).toEqual({
        inputTokens: 3_000,
        outputTokens: 150,
        costUsd: expect.closeTo(0.03, 10),
      });
      expect(await value(metrics.requests, { outcome: 'error' })).toBe(1);
      expect(await tokens()).toEqual({ input: 3_000, output: 150 });
    },
  );

  it.each(KINDS)(
    'an upstream failure after two billed calls: the 502 carries those two (%s)',
    async (kind) => {
      const model = mockScriptedModel([
        { toolCalls: [LOOKUP], ...BILLED },
        { toolCalls: [LOOKUP], ...BILLED },
        (): MockModelTurn => {
          throw upstreamFailure();
        },
      ]);
      const { client } = setup(model, { maxToolSteps: 5 });

      const error = await failureOf(kind, client, { messages: ask(), tools: lookupTool().tools });

      expect(error).toBeInstanceOf(AiUpstreamError);
      expect(aiUsageOf(error)).toEqual({
        inputTokens: 2_000,
        outputTokens: 100,
        costUsd: expect.closeTo(0.02, 10),
      });
      expect(await tokens()).toEqual({ input: 2_000, output: 100 });
    },
  );

  it.each(KINDS)('an upstream failure on the first call carries no usage (%s)', async (kind) => {
    const { client } = setup(mockFailingModel(upstreamFailure()));

    const error = await failureOf(kind, client, { messages: ask() });

    expect(error).toBeInstanceOf(AiUpstreamError);
    expect(aiUsageOf(error)).toBeUndefined();
    expect(await value(metrics.requests, { outcome: 'error' })).toBe(1);
    expect(await tokens()).toEqual({ input: undefined, output: undefined });
  });

  it.each(KINDS)('a timeout after one billed call carries that call (%s)', async (kind) => {
    // The second step never answers: the deadline cuts it, and no usage is reported for it.
    const model = mockScriptedModel([{ toolCalls: [LOOKUP], ...BILLED }, { hang: true }]);
    const { client } = setup(model, { requestTimeoutMs: 300 });

    const error = await failureOf(kind, client, { messages: ask(), tools: lookupTool().tools });

    expect(error).toBeInstanceOf(AiTimeoutError);
    expect(error).toMatchObject({ httpStatus: HttpStatus.GATEWAY_TIMEOUT });
    expect(aiUsageOf(error)).toEqual({ inputTokens: 1_000, outputTokens: 50, costUsd: 0.01 });
    expect(await value(metrics.requests, { outcome: 'timeout' })).toBe(1);
    expect(await tokens()).toEqual({ input: 1_000, output: 50 });
  });

  it.each(KINDS)(
    'a caller abort mid tool loop: the abort reason carries the calls billed before it (%s)',
    async (kind) => {
      const caller = new AbortController();
      const reason = new Error('client gone');
      const model = mockScriptedModel([
        { toolCalls: [LOOKUP], ...BILLED },
        (): MockModelTurn => {
          setTimeout(() => caller.abort(reason), 0);
          return { text: 'partial ', hang: true };
        },
      ]);
      const { client } = setup(model);

      const error = await failureOf(kind, client, {
        messages: ask(),
        tools: lookupTool().tools,
        signal: caller.signal,
      });

      expect(error).toBe(reason);
      expect(aiUsageOf(reason)).toEqual({ inputTokens: 1_000, outputTokens: 50, costUsd: 0.01 });
      expect(await value(metrics.requests, { outcome: 'aborted' })).toBe(1);
      expect(await tokens()).toEqual({ input: 1_000, output: 50 });
    },
  );

  it.each(KINDS)(
    "a caller abort during the SDK retry backoff: the caller's reason carries the call billed before it (%s)",
    async (kind) => {
      const caller = new AbortController();
      const reason = new Error('client gone');
      const retryable = new APICallError({
        message: 'upstream unavailable',
        url: 'https://openrouter.invalid/api/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 503,
        isRetryable: true,
      });
      const model = mockScriptedModel([
        { toolCalls: [LOOKUP], ...BILLED },
        (): MockModelTurn => {
          // The abort lands while the SDK waits out its first retry delay (2 s by default).
          setTimeout(() => caller.abort(reason), 10);
          throw retryable;
        },
      ]);
      const { client } = setup(model, { maxRetries: 2 });

      const error = await failureOf(kind, client, {
        messages: ask(),
        tools: lookupTool().tools,
        signal: caller.signal,
      });

      expect(error).toBe(reason);
      expect(aiUsageOf(reason)).toEqual({ inputTokens: 1_000, outputTokens: 50, costUsd: 0.01 });
      expect(await value(metrics.requests, { outcome: 'aborted' })).toBe(1);
      expect(await tokens()).toEqual({ input: 1_000, output: 50 });
    },
  );

  /** A lookup that settles only when its call aborts (rejecting); `onStart` runs first. */
  function slowLookup(onStart: () => void = () => undefined) {
    const cut = (signal?: AbortSignal) => new Error('lookup cut', { cause: signal?.reason });
    return {
      lookup: tool({
        inputSchema: jsonSchema({ type: 'object' }),
        execute: (_input: unknown, { abortSignal }: { abortSignal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            onStart();
            abortSignal?.addEventListener('abort', () => reject(cut(abortSignal)), { once: true });
          }),
      }),
    };
  }
  /** One billed call that asks for the lookup, then a step the cut never reaches. */
  const askThenWait = () =>
    mockScriptedModel([{ text: 'Looking. ', toolCalls: [LOOKUP], ...BILLED }, { text: 'never' }]);

  // A cut while a tool runs: the call that asked for it ended (billed), its step has not. A
  // stream ends without that step's end, so only the per-call meter counts it. Stream only:
  // generateText waits for the tool and ends the step before it throws.
  it('stream: the deadline lands while a tool runs: the timeout carries the call that asked for it', async () => {
    const model = askThenWait();
    const { client } = setup(model, { requestTimeoutMs: 300 });

    const error = await failureOf('stream', client, { messages: ask(), tools: slowLookup() });

    expect(error).toBeInstanceOf(AiTimeoutError);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(aiUsageOf(error)).toEqual({ inputTokens: 1_000, outputTokens: 50, costUsd: 0.01 });
    expect(await tokens()).toEqual({ input: 1_000, output: 50 });
  });

  it('stream: the caller aborts while a tool runs: the reason carries the call that asked for it', async () => {
    const caller = new AbortController();
    const reason = new Error('client gone');
    const model = askThenWait();
    const { client } = setup(model);

    const error = await failureOf('stream', client, {
      messages: ask(),
      tools: slowLookup(() => setTimeout(() => caller.abort(reason), 0)),
      signal: caller.signal,
    });

    expect(error).toBe(reason);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(aiUsageOf(reason)).toEqual({ inputTokens: 1_000, outputTokens: 50, costUsd: 0.01 });
    expect(await tokens()).toEqual({ input: 1_000, output: 50 });
  });

  it('stream: usage still rejects at once on an abort, its error already carrying the billed calls', async () => {
    const caller = new AbortController();
    const reason = new Error('client gone');
    const model = mockScriptedModel([
      { toolCalls: [LOOKUP], ...BILLED },
      { text: 'partial ', hang: true },
    ]);
    const { client } = setup(model);
    const call = client.stream({
      messages: ask(),
      tools: lookupTool().tools,
      signal: caller.signal,
    });
    const iterator = call.result.textStream[Symbol.asyncIterator]();
    // The second step's text: the first call ended before it began.
    expect((await iterator.next()).value).toBe('partial ');

    caller.abort(reason);
    // Read in the rejection handler, before the SDK does anything more about the abort.
    const settled = await Promise.race([
      call.usage.then(
        () => 'resolved',
        (error: unknown) => ({ error, usage: aiUsageOf(error) }),
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 1_000)),
    ]);

    expect(settled).toEqual({
      error: reason,
      usage: { inputTokens: 1_000, outputTokens: 50, costUsd: 0.01 },
    });
  });

  it('stream: an abort reason that is not an object carries no usage; the metrics count it', async () => {
    const caller = new AbortController();
    const model = mockScriptedModel([
      { toolCalls: [LOOKUP], ...BILLED },
      (): MockModelTurn => {
        setTimeout(() => caller.abort('bye'), 0);
        return { hang: true };
      },
    ]);
    const { client } = setup(model);

    const error = await failureOf('stream', client, {
      messages: ask(),
      tools: lookupTool().tools,
      signal: caller.signal,
    });

    // A primitive cannot key the usage: nothing to read, but the call is still metered.
    expect(error).toBe('bye');
    expect(aiUsageOf('bye')).toBeUndefined();
    expect(await value(metrics.requests, { outcome: 'aborted' })).toBe(1);
    expect(await tokens()).toEqual({ input: 1_000, output: 50 });
  });

  it('stream: a call whose usage comes after its error part counts on that error once the stream ended', async () => {
    // A provider failing mid-answer (as OpenRouter does): an error part, then the call's finish
    // with its usage. The error rejects `usage` first; the SDK reports the call's end after it.
    const chunks: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't0' },
      { type: 'text-delta', id: 't0', delta: 'par' },
      { type: 'error', error: upstreamFailure() },
      { type: 'text-end', id: 't0' },
      {
        type: 'finish',
        finishReason: { unified: 'error', raw: 'error' },
        usage: mockModelUsage({ inputTokens: 40, outputTokens: 4 }),
        providerMetadata: { openrouter: { usage: { cost: 0.004 } } },
      },
    ];
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks, chunkDelayInMs: 0 }) }),
    });
    const { client } = setup(model);

    const call = client.stream({ messages: ask() });
    const deltas = read(call.result.textStream);
    const rejection = await call.usage.then(
      () => undefined,
      (error: unknown) => ({ error, usage: aiUsageOf(error) }),
    );
    expect(await deltas).toEqual(['par']);

    expect(rejection?.error).toBeInstanceOf(AiUpstreamError);
    expect(rejection?.usage).toBeUndefined();
    // The same error reads the call once the stream ended, and the metrics counted it too.
    expect(aiUsageOf(rejection?.error)).toEqual({
      inputTokens: 40,
      outputTokens: 4,
      costUsd: 0.004,
    });
    expect(await value(metrics.requests, { outcome: 'error' })).toBe(1);
    expect(await tokens()).toEqual({ input: 40, output: 4 });
  });

  it('stream: a caller abort after the call ended reads the whole call, counted once', async () => {
    const caller = new AbortController();
    const { client } = setup(
      mockStreamModel(['done'], { usage: { inputTokens: 4, outputTokens: 3 } }),
    );
    const call = client.stream({ messages: ask(), signal: caller.signal });
    expect(await read(call.result.textStream)).toEqual(['done']);
    const usage = await call.usage;

    // A consumer that leaves after the end (still reading the deltas) aborts with its reason.
    caller.abort();

    expect(aiUsageOf(caller.signal.reason)).toEqual(usage);
    expect(await value(metrics.requests, { outcome: 'success' })).toBe(1);
    expect(await value(metrics.requests, { outcome: 'aborted' })).toBeUndefined();
    expect(await tokens()).toEqual({ input: 4, output: 3 });
  });

  it('reads nothing for a guard refusal or any value no call failed with', async () => {
    const { client } = setup(mockTextModel('hi'));
    const refused = await client
      .generate({ messages: ask(), model: 'vendor/expensive' })
      .catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(AiModelNotAllowedError);
    for (const other of [refused, new Error('other'), 'text', undefined, null]) {
      expect(aiUsageOf(other)).toBeUndefined();
    }
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
