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
 * the caller's abort signal and the `AI_REQUEST_TIMEOUT_MS` deadline. Every call records metrics
 * and a span and logs ids, model, token counts and latency only: never prompt or completion text,
 * nor upstream messages.
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

/** One model call: its deadline, combined signal, span, and exactly-once metrics and log. */
class AiCall<TOOLS extends ToolSet> {
  readonly model: string;
  readonly signal: AbortSignal;
  private readonly startedAt = performance.now();
  private readonly deadline = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private readonly span: Span;
  private readonly maxOutputTokens: number;
  private settled = false;

  constructor(private readonly ctx: AiCallContext) {
    this.model = ctx.model;
    const { requestTimeoutMs } = ctx.config;
    this.timer = setTimeout(
      () => this.deadline.abort(new AiTimeoutError(requestTimeoutMs)),
      requestTimeoutMs,
    );
    this.timer.unref();
    this.signal =
      ctx.callerSignal === undefined
        ? this.deadline.signal
        : AbortSignal.any([ctx.callerSignal, this.deadline.signal]);
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
    return {
      model: this.ctx.languageModel,
      maxOutputTokens,
      maxRetries: this.ctx.config.maxRetries,
      abortSignal: this.signal,
      ...(input.system === undefined ? {} : { system: input.system }),
      ...(input.tools === undefined
        ? {}
        : { tools: input.tools, stopWhen: isStepCount(this.ctx.config.maxToolSteps) }),
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

  /** Maps `error` to what the caller sees; records the failure once (later calls only map). */
  fail(error: unknown): unknown {
    let outcome: AiCallOutcome;
    let mapped: unknown;
    if (this.deadline.signal.aborted) {
      outcome = 'timeout';
      mapped = this.deadline.signal.reason;
    } else if (this.ctx.callerSignal?.aborted === true) {
      outcome = 'aborted';
      mapped = error;
    } else {
      outcome = 'error';
      mapped = isDomainException(error) ? error : new AiUpstreamError({ cause: error });
    }
    if (!this.finish(outcome)) return mapped;
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
  private finish(outcome: AiCallOutcome, usage?: AiUsage): boolean {
    if (this.settled) return false;
    this.settled = true;
    clearTimeout(this.timer);
    this.ctx.metrics.record(this.model, outcome, this.elapsedMs(), usage);
    return true;
  }
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
