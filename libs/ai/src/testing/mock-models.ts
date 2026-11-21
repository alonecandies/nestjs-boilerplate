import type { AiConfig } from '@platform/config';
import { type LanguageModel, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { AiModelProvider } from '../ai-model.provider.js';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer TPart> ? TPart : never;
/** What the SDK passed to the mock model (prompt, abort signal, max output tokens…). */
export type MockModelCall = MockLanguageModelV4['doGenerateCalls'][number];

export interface MockTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const DEFAULT_USAGE: MockTokenUsage = { inputTokens: 10, outputTokens: 5 };
const STOP = { unified: 'stop', raw: 'stop' } as const;

/** Usage in the provider (V4) shape the SDK reads from a model. */
export function mockModelUsage(usage: MockTokenUsage = DEFAULT_USAGE): GenerateResult['usage'] {
  return {
    inputTokens: {
      total: usage.inputTokens,
      noCache: usage.inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: usage.outputTokens, text: usage.outputTokens, reasoning: undefined },
  };
}

/** A model that answers every `generate` with `text`. */
export function mockTextModel(
  text: string,
  usage: MockTokenUsage = DEFAULT_USAGE,
  modelId = 'mock/model',
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: STOP,
      usage: mockModelUsage(usage),
      warnings: [],
    }),
  });
}

export interface MockStreamOptions {
  readonly usage?: MockTokenUsage;
  /** Delay before each chunk (default 0). */
  readonly chunkDelayInMs?: number;
}

/** The stream parts of a text answer split into `chunks`, ending with `finish`. */
export function mockTextStreamParts(
  chunks: readonly string[],
  usage: MockTokenUsage = DEFAULT_USAGE,
): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't0' },
    ...chunks.map((delta): StreamPart => ({ type: 'text-delta', id: 't0', delta })),
    { type: 'text-end', id: 't0' },
    { type: 'finish', finishReason: STOP, usage: mockModelUsage(usage) },
  ];
}

/** A model that streams `chunks` for every `stream` (and stops on its abort signal). */
export function mockStreamModel(
  chunks: readonly string[],
  options: MockStreamOptions = {},
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: abortable(
        simulateReadableStream({
          chunks: mockTextStreamParts(chunks, options.usage),
          chunkDelayInMs: options.chunkDelayInMs ?? 0,
        }),
        abortSignal,
      ),
    }),
  });
}

/** Errors the stream when `signal` aborts, like a real HTTP body whose request was cancelled. */
function abortable<T>(
  source: ReadableStream<T>,
  signal: AbortSignal | undefined,
): ReadableStream<T> {
  if (signal === undefined) return source;
  const reader = source.getReader();
  return new ReadableStream<T>({
    start(controller) {
      const onAbort = (): void => {
        controller.error(signal.reason);
        void reader.cancel(signal.reason).catch(() => undefined);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** Rejects with the signal's reason once it aborts (never settles otherwise). */
const untilAborted = (signal: AbortSignal | undefined): Promise<never> =>
  new Promise((_resolve, reject) => {
    if (signal === undefined) return;
    const fail = (): void => reject(abortReason(signal));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error('aborted', { cause: signal.reason });

/**
 * A model that never answers: `generate` waits for its abort signal, `stream` sends `chunks` then
 * waits. Pins cancellation and timeouts (`aborted` resolves once the SDK's signal fired).
 */
export function mockHangingModel(chunks: readonly string[] = []): MockLanguageModelV4 & {
  readonly aborted: Promise<void>;
} {
  let markAborted!: () => void;
  const aborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });
  const watch = (signal: AbortSignal | undefined): void => {
    if (signal?.aborted) markAborted();
    else signal?.addEventListener('abort', () => markAborted(), { once: true });
  };
  const model = new MockLanguageModelV4({
    doGenerate: async ({ abortSignal }) => {
      watch(abortSignal);
      return untilAborted(abortSignal);
    },
    doStream: async ({ abortSignal }) => {
      watch(abortSignal);
      const head = mockTextStreamParts(chunks).slice(0, -2);
      return {
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            for (const part of head) controller.enqueue(part);
            untilAborted(abortSignal).catch((reason: unknown) => controller.error(reason));
          },
        }),
      };
    },
  });
  return Object.assign(model, { aborted });
}

/** One tool call a scripted model asks for: `input` is JSON-encoded as a provider sends it. */
export interface MockToolCall {
  readonly toolName: string;
  readonly input: unknown;
}

/** What a scripted model answers on one step: text, tool calls, or both. */
export interface MockModelTurn {
  readonly text?: string;
  readonly toolCalls?: readonly MockToolCall[];
  readonly usage?: MockTokenUsage;
  /** The step's cost as OpenRouter usage accounting reports it (`openrouter.usage.cost`). */
  readonly costUsd?: number;
  /**
   * The step never ends: it waits for its abort signal (a `stream` sends its text first), like a
   * model the deadline or the caller cuts mid-answer. No usage is reported for it.
   */
  readonly hang?: boolean;
}

/** A turn, or a function of the call (its prompt holds the tool results of the step before). */
export type MockModelScript = MockModelTurn | ((call: MockModelCall) => MockModelTurn);

const TOOL_CALLS = { unified: 'tool-calls', raw: 'tool_calls' } as const;

/**
 * A model that answers its n-th call (`generate` or `stream`) with `turns[n]`, the last turn
 * repeating: e.g. `[{ toolCalls: [{ toolName: 'x', input: {} }] }, { text: 'done' }]` calls a tool
 * on the first step and answers on the second. Tool call ids are `call-<step>-<index>`.
 */
export function mockScriptedModel(turns: readonly MockModelScript[]): MockLanguageModelV4 {
  if (turns.length === 0) throw new Error('mockScriptedModel needs at least one turn');
  let step = 0;
  const next = (call: MockModelCall) => {
    const index = step;
    step += 1;
    const script = turns[Math.min(index, turns.length - 1)] as MockModelScript;
    const turn = typeof script === 'function' ? script(call) : script;
    const toolCalls = (turn.toolCalls ?? []).map((toolCall, position) => ({
      type: 'tool-call' as const,
      toolCallId: `call-${index}-${position}`,
      toolName: toolCall.toolName,
      input: JSON.stringify(toolCall.input),
    }));
    return {
      turn,
      toolCalls,
      finishReason: toolCalls.length > 0 ? TOOL_CALLS : STOP,
      usage: mockModelUsage(turn.usage),
      metadata:
        turn.costUsd === undefined
          ? {}
          : { providerMetadata: { openrouter: { usage: { cost: turn.costUsd } } } },
    };
  };
  return new MockLanguageModelV4({
    doGenerate: async (call) => {
      const { turn, toolCalls, finishReason, usage, metadata } = next(call);
      if (turn.hang === true) return untilAborted(call.abortSignal);
      return {
        content: [
          ...(turn.text === undefined ? [] : [{ type: 'text' as const, text: turn.text }]),
          ...toolCalls,
        ],
        finishReason,
        usage,
        ...metadata,
        warnings: [],
      };
    },
    doStream: async (call) => {
      const { turn, toolCalls, finishReason, usage, metadata } = next(call);
      const text: StreamPart[] =
        turn.text === undefined
          ? []
          : [
              { type: 'text-start', id: 't0' },
              { type: 'text-delta', id: 't0', delta: turn.text },
              { type: 'text-end', id: 't0' },
            ];
      if (turn.hang === true) {
        const head: StreamPart[] = [{ type: 'stream-start', warnings: [] }, ...text.slice(0, -1)];
        return {
          stream: new ReadableStream<StreamPart>({
            start(controller) {
              for (const part of head) controller.enqueue(part);
              untilAborted(call.abortSignal).catch((reason: unknown) => controller.error(reason));
            },
          }),
        };
      }
      return {
        stream: simulateReadableStream<StreamPart>({
          chunks: [
            { type: 'stream-start', warnings: [] },
            ...text,
            ...toolCalls,
            { type: 'finish', finishReason, usage, ...metadata },
          ],
          chunkDelayInMs: 0,
        }),
      };
    },
  });
}

/** A model whose every call fails with `error` (e.g. an `APICallError`). */
export function mockFailingModel(error: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw error;
    },
    doStream: async () => {
      throw error;
    },
  });
}

export interface MockModelRequest {
  readonly model: string;
  readonly fallbacks: readonly string[];
}

/**
 * `AiModelProvider` for tests: hands out `model` (or `model(id)`) and records which model and
 * fallbacks the client asked for. Override the provider with it:
 * `.overrideProvider(AiModelProvider).useValue(new MockAiModelProvider(mockTextModel('hi')))`.
 */
export class MockAiModelProvider extends AiModelProvider {
  readonly requests: MockModelRequest[] = [];

  constructor(private readonly model: LanguageModel | ((modelId: string) => LanguageModel)) {
    super();
  }

  override languageModel(model: string, fallbacks: readonly string[]): LanguageModel {
    this.requests.push({ model, fallbacks: [...fallbacks] });
    return typeof this.model === 'function' ? this.model(model) : this.model;
  }
}

/** An enabled `AiConfig` with a fake key and short bounds; override any field. */
export function aiTestConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    enabled: true,
    apiKey: 'sk-or-v1-test-key-never-sent',
    baseUrl: 'https://openrouter.invalid/api/v1',
    defaultModel: 'mock/default',
    allowedModels: ['mock/default', 'mock/other'],
    fallbackModels: [],
    maxOutputTokens: 256,
    requestTimeoutMs: 5_000,
    maxRetries: 0,
    maxInputChars: 10_000,
    historyMaxMessages: 20,
    historyMaxTokens: 8_000,
    maxToolSteps: 3,
    ...overrides,
  };
}
