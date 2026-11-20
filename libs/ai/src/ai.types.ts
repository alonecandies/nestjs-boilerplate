import type { FinishReason, generateText, ModelMessage, streamText, ToolSet } from 'ai';

/** Tokens (and, when OpenRouter reports it, the cost) of one call, summed over its steps. */
export interface AiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** OpenRouter usage accounting, in USD; `undefined` when the provider did not report it. */
  readonly costUsd: number | undefined;
}

export interface AiCallInput<TOOLS extends ToolSet = ToolSet> {
  /** The conversation to send (history window and the new user message). */
  readonly messages: readonly ModelMessage[];
  /** Default: `AI_DEFAULT_MODEL`. Must be the default or in `AI_ALLOWED_MODELS` (else 422). */
  readonly model?: string;
  /** System instructions (counted in `AI_MAX_INPUT_CHARS`). */
  readonly system?: string;
  /** Tools the model may call; the loop stops after `AI_MAX_TOOL_STEPS` steps. */
  readonly tools?: TOOLS;
  /** Capped by `AI_MAX_OUTPUT_TOKENS` (also the default). */
  readonly maxOutputTokens?: number;
  /** The caller's cancellation (a client that disconnected): aborts the upstream call. */
  readonly signal?: AbortSignal;
}

/** The AI SDK result of `generateText`, for steps, tool calls and response messages. */
export type AiSdkGenerateResult<TOOLS extends ToolSet = ToolSet> = Awaited<
  ReturnType<typeof generateText<TOOLS>>
>;
/** The AI SDK result of `streamText` (`textStream`, `fullStream`, …). */
export type AiSdkStreamResult<TOOLS extends ToolSet = ToolSet> = ReturnType<
  typeof streamText<TOOLS>
>;

export interface AiGenerateResult<TOOLS extends ToolSet = ToolSet> {
  /** The model asked for (OpenRouter may have answered with a fallback). */
  readonly model: string;
  readonly text: string;
  readonly finishReason: FinishReason;
  readonly usage: AiUsage;
  readonly latencyMs: number;
  readonly result: AiSdkGenerateResult<TOOLS>;
}

export interface AiStreamResult<TOOLS extends ToolSet = ToolSet> {
  readonly model: string;
  /** The SDK's stream: read `textStream` or `fullStream`. */
  readonly result: AiSdkStreamResult<TOOLS>;
  /**
   * Settles when the stream ends: the usage on success; on failure an `AiTimeoutError`, an
   * `AiUpstreamError`, or the caller's abort reason. Never an unhandled rejection when ignored.
   */
  readonly usage: Promise<AiUsage>;
}
