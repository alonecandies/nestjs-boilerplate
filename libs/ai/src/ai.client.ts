import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { isDomainException } from '@platform/common';
import { type AiConfig, aiConfig } from '@platform/config';
import {
  APICallError,
  type FinishReason,
  generateText,
  isStepCount,
  type LanguageModelUsage,
  type ModelMessage,
  type ProviderMetadata,
  RetryError,
  streamText,
  type ToolSet,
} from 'ai';
import {
  AiDisabledError,
  AiInputTooLargeError,
  AiModelNotAllowedError,
  AiTimeoutError,
  AiUpstreamError,
} from './ai.errors.js';
import { type AiCallOutcome, AiMetrics } from './ai.metrics.js';
import type { AiCallInput, AiGenerateResult, AiStreamResult, AiUsage } from './ai.types.js';
import { AiModelProvider } from './ai-model.provider.js';

const TRACER = '@platform/ai';

/**
 * The one way to call a language model. Guards first (disabled → 503, model outside the allowlist
 * → 422, input over `AI_MAX_INPUT_CHARS` as `aiInputChars` counts it → 422), then the AI SDK call
 * through `AiModelProvider` with the output-token cap, the SDK retries (retryable failures only),
 * the caller's abort signal and the `AI_REQUEST_TIMEOUT_MS` deadline. With tools, at most
 * `AI_MAX_TOOL_STEPS` model steps, the last with tool choice `none`: the call ends on an answer in
 * text, never on tool calls (a model that calls one there anyway → 502). Every call records metrics
 * and a span and logs ids, model, token counts and latency only: never prompt or completion text,
 * nor upstream messages. Each model call's usage is metered as it ends, so a call that fails keeps
 * what its completed model calls were billed: `aiUsageOf(error)`, and its tokens in the metrics.
 */
@Injectable()
export class AiClient {
  private readonly logger = new Logger(AiClient.name);

  constructor(
    @Inject(aiConfig.KEY) private readonly config: AiConfig,
    private readonly models: AiModelProvider,
    private readonly metrics: AiMetrics,
  ) {}

  async generate<TOOLS extends ToolSet = ToolSet>(
    input: AiCallInput<TOOLS>,
  ): Promise<AiGenerateResult<TOOLS>> {
    const call = this.start(input, 'generate');
    try {
      const result = await generateText<TOOLS>({
        ...call.options(input),
        messages: [...input.messages],
      });
      const usage = toUsage(result.usage, result.steps);
      call.succeed(usage, result.finishReason);
      return {
        model: call.model,
        text: result.text,
        finishReason: result.finishReason,
        usage,
        latencyMs: call.elapsedMs(),
        result,
      };
    } catch (error) {
      throw call.fail(error);
    }
  }

  /** Throws the guard errors synchronously; later failures reject `usage`. */
  stream<TOOLS extends ToolSet = ToolSet>(input: AiCallInput<TOOLS>): AiStreamResult<TOOLS> {
    const call = this.start(input, 'stream');
    const { promise: usage, resolve, reject } = Promise.withResolvers<AiUsage>();
    usage.catch(() => undefined); // a caller that ignores `usage` gets no unhandled rejection
    // Abort and timeout settle here, at once, whatever the SDK reports afterwards. A signal that
    // is already aborted fires no event: settle now (the SDK ends the stream on its abort path).
    const onAbort = (): void => reject(call.fail(call.signal.reason));
    if (call.signal.aborted) onAbort();
    else call.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const result = streamText<TOOLS>({
        ...call.options(input),
        messages: [...input.messages],
        onEnd: (event) => {
          const total = toUsage(event.usage, event.steps);
          call.succeed(total, event.finishReason);
          resolve(total);
        },
        onError: ({ error }) => reject(call.fail(error)),
        // The SDK's abort path ends the stream without onEnd or onError.
        onAbort,
      });
      return { model: call.model, result, usage };
    } catch (error) {
      throw call.fail(error);
    }
  }

  private start<TOOLS extends ToolSet>(
    input: AiCallInput<TOOLS>,
    kind: 'generate' | 'stream',
  ): AiCall<TOOLS> {
    const { config } = this;
    if (!config.enabled) throw new AiDisabledError();
    const model = input.model ?? config.defaultModel;
    if (!config.allowedModels.includes(model)) throw new AiModelNotAllowedError(model);
    if (aiInputChars(input.messages, input.system) > config.maxInputChars) {
      throw new AiInputTooLargeError(config.maxInputChars);
    }
    const fallbacks = config.fallbackModels.filter((fallback) => fallback !== model);
    return new AiCall<TOOLS>({
      kind,
      model,
      languageModel: this.models.languageModel(model, fallbacks),
      config,
      callerSignal: input.signal,
      metrics: this.metrics,
      logger: this.logger,
    });
  }
}

interface AiCallContext {
  readonly kind: 'generate' | 'stream';
  readonly model: string;
  readonly languageModel: ReturnType<AiModelProvider['languageModel']>;
  readonly config: AiConfig;
  readonly callerSignal: AbortSignal | undefined;
  readonly metrics: AiMetrics;
  readonly logger: Logger;
}

/** One call: its deadline, abort signal, span, metered usage, and exactly-once metrics and log. */
class AiCall<TOOLS extends ToolSet> {
  readonly model: string;
  readonly signal: AbortSignal;
  private readonly startedAt = performance.now();
  private readonly deadline = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private readonly span: Span;
  private readonly maxOutputTokens: number;
  /** The usage of the model calls that ended so far; what `aiUsageOf` reads for a failure. */
  private readonly metered: UsageMeter = { usage: undefined };
  /** Set by the first settlement, which alone records the metrics. */
  private outcome: AiCallOutcome | undefined;

  constructor(private readonly ctx: AiCallContext) {
    this.model = ctx.model;
    const { requestTimeoutMs } = ctx.config;
    this.timer = setTimeout(
      () => this.deadline.abort(new AiTimeoutError(requestTimeoutMs)),
      requestTimeoutMs,
    );
    this.timer.unref();
    // One plain signal that the deadline and the caller abort, not an `AbortSignal.any` composite:
    // Node keeps a composite with an abort listener (stream's, never removed) in a strong set
    // while its sources live, which pinned every finished call. The forwarders stay after the call
    // ends, so a caller abort then still reaches it (`aiUsageOf` of its reason).
    const call = new AbortController();
    const forward = (source: AbortSignal): void => {
      if (source.aborted) call.abort(source.reason);
      else source.addEventListener('abort', () => call.abort(source.reason), { once: true });
    };
    forward(this.deadline.signal);
    if (ctx.callerSignal !== undefined) forward(ctx.callerSignal);
    this.signal = call.signal;
    this.maxOutputTokens = ctx.config.maxOutputTokens;
    this.span = trace.getTracer(TRACER).startSpan(`ai.${ctx.kind}`, {
      attributes: {
        'gen_ai.system': 'openrouter',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': ctx.model,
      },
    });
  }

  /** The SDK options shared by `generateText` and `streamText`. */
  options(input: AiCallInput<TOOLS>) {
    const maxOutputTokens = Math.min(input.maxOutputTokens ?? Infinity, this.maxOutputTokens);
    this.span.setAttribute('gen_ai.request.max_tokens', maxOutputTokens);
    const { maxToolSteps } = this.ctx.config;
    return {
      model: this.ctx.languageModel,
      maxOutputTokens,
      maxRetries: this.ctx.config.maxRetries,
      abortSignal: this.signal,
      // Every model call that ends is billed, whether or not the whole call then succeeds.
      onLanguageModelCallEnd: (event: ModelCallEnd) => this.meter(event),
      ...(input.system === undefined ? {} : { system: input.system }),
      ...(input.tools === undefined
        ? {}
        : {
            tools: input.tools,
            stopWhen: isStepCount(maxToolSteps),
            // The last step must answer in text, so a call never ends on tool calls that no step
            // reads (an empty answer). The tools stay listed, keeping the prompt's tool calls
            // valid; the SDK runs none on that step and fails a model that calls one anyway
            // (ToolChoiceViolationError, so 502 AI_UPSTREAM_ERROR).
            prepareStep: ({ stepNumber }: { readonly stepNumber: number }) =>
              stepNumber >= maxToolSteps - 1 ? { toolChoice: 'none' as const } : undefined,
          }),
    };
  }

  elapsedMs(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  succeed(usage: AiUsage, finishReason: FinishReason): void {
    if (!this.finish('success', usage)) return;
    this.span.setAttributes({
      'gen_ai.usage.input_tokens': usage.inputTokens,
      'gen_ai.usage.output_tokens': usage.outputTokens,
      'gen_ai.response.finish_reasons': [finishReason],
    });
    this.span.end();
    this.ctx.logger.debug(
      `AI ${this.ctx.kind} model=${this.model} outcome=success finishReason=${finishReason} ` +
        `inputTokens=${usage.inputTokens} outputTokens=${usage.outputTokens} ` +
        `latencyMs=${this.elapsedMs()}`,
    );
  }

  /**
   * Maps `error` to what the caller sees, which then carries the metered usage (`aiUsageOf`), every
   * time; records the failure once (later calls only map).
   */
  fail(error: unknown): unknown {
    let outcome: AiCallOutcome;
    let mapped: unknown;
    if (this.deadline.signal.aborted) {
      outcome = 'timeout';
      mapped = this.deadline.signal.reason;
    } else if (this.ctx.callerSignal?.aborted === true) {
      outcome = 'aborted';
      // The caller's reason, whatever the SDK reported (during a retry backoff it throws a fresh
      // AbortError, not the reason): `generate` throws what `stream` rejects `usage` with. The
      // SDK's own error stays keyed too, so a reader holding that one still finds the usage.
      mapped = this.ctx.callerSignal.reason;
      if (isWeakKey(error)) failedCalls.set(error, this.metered);
    } else {
      outcome = 'error';
      mapped = isDomainException(error) ? error : new AiUpstreamError({ cause: error });
    }
    if (isWeakKey(mapped)) failedCalls.set(mapped, this.metered);
    if (!this.finish(outcome, this.metered.usage)) return mapped;
    this.span.setAttributes({ 'ai.outcome': outcome, 'error.type': errorName(error) });
    this.span.setStatus({ code: SpanStatusCode.ERROR });
    this.span.end();
    const message =
      `AI ${this.ctx.kind} model=${this.model} outcome=${outcome} error=${errorName(error)}` +
      `${statusOf(error)} latencyMs=${this.elapsedMs()}`;
    if (outcome === 'aborted') this.ctx.logger.debug(message);
    else this.ctx.logger.warn(message);
    return mapped;
  }

  /** First settlement wins: clears the deadline and records the metrics. */
  private finish(outcome: AiCallOutcome, usage: AiUsage | undefined): boolean {
    if (this.outcome !== undefined) return false;
    this.outcome = outcome;
    clearTimeout(this.timer);
    this.ctx.metrics.record(this.model, outcome, this.elapsedMs(), usage);
    return true;
  }

  /**
   * Adds the usage of one model call as it ends (before its tool calls run). A failure records what
   * was metered then; a model call that ends after it (a streamed call whose usage the provider
   * sends after its error part) still adds to the failure's usage and to the token metrics.
   */
  private meter(event: ModelCallEnd): void {
    const usage = toUsage(event.usage, [event]);
    this.metered.usage = sumUsage(this.metered.usage, usage);
    if (this.outcome !== undefined && this.outcome !== 'success') {
      this.ctx.metrics.countTokens(this.model, usage);
    }
  }
}

/** What the SDK reports as each model call ends (`onLanguageModelCallEnd`). */
interface ModelCallEnd {
  readonly usage: LanguageModelUsage;
  readonly providerMetadata?: ProviderMetadata | undefined;
}

/** The usage a call metered so far, shared by reference with the errors it failed with. */
interface UsageMeter {
  usage: AiUsage | undefined;
}

/** The meter of each failed call by the error it failed with (`aiUsageOf`). */
const failedCalls = new WeakMap<object, UsageMeter>();

/**
 * What a failed `AiClient` call was billed for: the tokens and cost of its model calls that ended
 * before it failed (OpenRouter bills each, the step that broke a tool loop included; one cut
 * mid-answer reports nothing). Pass what the call failed with: the `AiTimeoutError` or
 * `AiUpstreamError` that `generate` throws or `stream` rejects `usage` with, or the caller's abort
 * reason (also when the abort came after the call ended: then the whole call; `generate` throws that
 * reason when the caller aborts, also during the SDK's retry backoff). `undefined` when no
 * model call ended, for a guard refusal or any other value, and for an abort reason that is not an
 * object (nothing can key it). Read live: a streamed call whose usage arrives after its error part
 * is included once the stream ended. One reason object shared by concurrent calls reads only one.
 */
export function aiUsageOf(error: unknown): AiUsage | undefined {
  return isWeakKey(error) ? failedCalls.get(error)?.usage : undefined;
}

/** Whether `value` can key a `WeakMap` (a primitive abort reason cannot). */
const isWeakKey = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

/** `a + b`; the cost stays `undefined` until a model call reports one. */
function sumUsage(a: AiUsage | undefined, b: AiUsage): AiUsage {
  if (a === undefined) return b;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: b.costUsd === undefined ? a.costUsd : (a.costUsd ?? 0) + b.costUsd,
  };
}

/**
 * The input characters `AI_MAX_INPUT_CHARS` counts: the system instructions, message text, and
 * every other part (tool calls, tool results, files) as its JSON. `AiClient` refuses a call above
 * the cap with this measure (422 `AI_INPUT_TOO_LARGE`); a caller that trims its history to fit
 * measures with it too. A sum over the messages, so it can price them one at a time.
 */
export function aiInputChars(messages: readonly ModelMessage[], system?: string): number {
  let total = system?.length ?? 0;
  for (const message of messages) {
    if (typeof message.content === 'string') {
      total += message.content.length;
      continue;
    }
    for (const part of message.content) {
      total += part.type === 'text' ? part.text.length : (JSON.stringify(part)?.length ?? 0);
    }
  }
  return total;
}

function toUsage(
  total: LanguageModelUsage,
  steps: readonly { readonly providerMetadata?: ProviderMetadata | undefined }[],
): AiUsage {
  let costUsd: number | undefined;
  for (const step of steps) {
    const cost = field(step.providerMetadata?.['openrouter']?.['usage'], 'cost');
    if (typeof cost === 'number') costUsd = (costUsd ?? 0) + cost;
  }
  return {
    inputTokens: total.inputTokens ?? 0,
    outputTokens: total.outputTokens ?? 0,
    costUsd,
  };
}

/** `value[key]` of a JSON object, `undefined` for anything else. */
const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;

const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/** ` status=<code>` of an upstream HTTP failure (also behind the SDK's RetryError). */
function statusOf(error: unknown): string {
  const last = RetryError.isInstance(error) ? error.lastError : error;
  return APICallError.isInstance(last) && last.statusCode !== undefined
    ? ` status=${last.statusCode}`
    : '';
}
