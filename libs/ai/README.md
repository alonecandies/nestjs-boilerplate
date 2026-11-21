# @platform/ai

Language-model calls through [OpenRouter](https://openrouter.ai) on the Vercel AI SDK (`ai` 7,
`@openrouter/ai-sdk-provider` 3). Names no domain: conversations, history and tools belong to the
domain that uses it.

- off by default (`AI_ENABLED=false`): every call is refused before any model is built
- a model allowlist, optional OpenRouter fallbacks, and caps on output tokens, input length and time
- cancellation: the caller's `AbortSignal` and the deadline abort the upstream call
- metrics and an OpenTelemetry span per call, logs with model, token counts and latency only

## Public API

| Export                                                                                                                                                | Kind          | Purpose                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AiModule.forRootAsync()`                                                                                                                             | global module | Loads the `ai` config namespace and provides `AiClient`. Boots without a key while disabled.                                                                                                                                                                                                                                                                                     |
| `AiClient.generate({ messages, model?, system?, tools?, maxOutputTokens?, signal? })`                                                                 | service       | One call: `{ model, text, finishReason, usage, latencyMs, result }` (`result` is the SDK's `generateText` result: steps, tool calls, response messages). With `tools`, the loop stops after `AI_MAX_TOOL_STEPS` steps.                                                                                                                                                           |
| `AiClient.stream(...)`                                                                                                                                | service       | Same input; returns `{ model, result, usage }` at once: `result` is the SDK's `streamText` result (`textStream`, `fullStream`), `usage` settles when the stream ends (rejects on timeout, upstream failure or abort, at once for a signal already aborted; never unhandled). Guard errors are thrown synchronously.                                                              |
| `aiInputChars(messages, system?)`                                                                                                                     | function      | The input characters `AI_MAX_INPUT_CHARS` counts: the system instructions, message text, and every other part (tool calls, tool results, files) as its JSON. `AiClient` refuses a call above the cap with it (422); a caller that trims its history to fit (the ai domain's history window) measures with it too, so the two cannot drift.                                       |
| `AiUsage`                                                                                                                                             | type          | `{ inputTokens, outputTokens, costUsd }` summed over steps; `costUsd` from OpenRouter usage accounting, `undefined` when not reported.                                                                                                                                                                                                                                           |
| `AiDisabledError` (503), `AiModelNotAllowedError` (422), `AiInputTooLargeError` (422), `AiTimeoutError` (504), `AiUpstreamError` (502), `AiErrorCode` | errors        | `DomainException`s with codes `AI_DISABLED`, `AI_MODEL_NOT_ALLOWED`, `AI_INPUT_TOO_LARGE`, `AI_TIMEOUT`, `AI_UPSTREAM_ERROR`. A caller abort rethrows the SDK's abort error.                                                                                                                                                                                                     |
| `AiModelProvider`, `OpenRouterModelProvider`                                                                                                          | port, adapter | Builds the SDK model for a model id and its fallbacks (OpenRouter `models` routing, usage accounting on). Override the port in tests.                                                                                                                                                                                                                                            |
| `AiMetrics`, `AI_REQUESTS_TOTAL`, `AI_TOKENS_TOTAL`, `AI_REQUEST_DURATION_SECONDS`                                                                    | metrics       | `ai_requests_total{model,outcome}` (`success`, `error`, `timeout`, `aborted`), `ai_tokens_total{model,kind}` (`input`, `output`), `ai_request_duration_seconds{model}`. `model` is the requested model, bounded by the allowlist.                                                                                                                                                |
| `@platform/ai/testing`                                                                                                                                | test doubles  | `MockAiModelProvider`, `mockTextModel`, `mockStreamModel`, `mockHangingModel` (waits for its abort signal; `aborted` resolves when it fired), `mockFailingModel`, `mockScriptedModel` (answers its n-th step with scripted text and tool calls, for tool loops), `mockTextStreamParts`, `mockModelUsage`, `aiTestConfig`: built on the AI SDK's `ai/test` `MockLanguageModelV4`. |

Configuration: the `ai` namespace in [docs/CONFIGURATION.md](../../docs/CONFIGURATION.md) (`AI_ENABLED`,
`OPENROUTER_API_KEY`, `AI_DEFAULT_MODEL`, `AI_ALLOWED_MODELS`, `AI_FALLBACK_MODELS`, the bounds, and the
history and tool-step knobs the calling domain applies).

## Usage

```ts
// app module
imports: [AiModule.forRootAsync()];

// a handler
const reply = await this.ai.generate({ messages, model: requested, signal });
await this.usageLog.record({ model: reply.model, ...reply.usage, latencyMs: reply.latencyMs });

// streaming: abort on client disconnect, persist once `usage` settles
const call = this.ai.stream({ messages, signal: abortOnClose.signal });
for await (const delta of call.result.textStream) send(delta);
const usage = await call.usage;
```

## Privacy

Prompts and completions are never logged and never put on spans. A failure logs the error name and
the upstream HTTP status, never the upstream message (a provider may echo the prompt in it).

## Testing

No test calls OpenRouter. Unit specs build `AiClient` with `aiTestConfig()` and a
`MockAiModelProvider`; module specs override `AiModelProvider`:

```ts
const provider = new MockAiModelProvider(mockTextModel('hello'));
Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(AiModelProvider)
  .useValue(provider);
```

`OpenRouterModelProvider` takes a `fetch` as its second argument; its spec answers with a stub.
