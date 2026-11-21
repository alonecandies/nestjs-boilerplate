import { type AiCallInput, aiInputChars } from '@platform/ai';
import { APPROX_CHARS_PER_TOKEN } from '../ai.constants.js';
import type { Message, MessageContent } from '../domain/ai.types.js';

/** A message as `AiClient` takes it (the AI SDK's `ModelMessage`). */
export type ModelMessage = AiCallInput['messages'][number];

export interface HistoryLimits {
  /** `AI_HISTORY_MAX_MESSAGES`. */
  readonly maxMessages: number;
  /** `AI_HISTORY_MAX_TOKENS` (approximate: characters / 4). */
  readonly maxTokens: number;
  /**
   * Input characters as `AiClient`'s guard counts them (`aiInputChars`): what `AI_MAX_INPUT_CHARS`
   * leaves once the new message and the system instructions are counted. 0 or less: no history.
   */
  readonly maxChars: number;
}

/** A stored message as the model call takes it. */
export const toModelMessage = (message: Message): ModelMessage =>
  ({ role: message.role, content: message.content }) as unknown as ModelMessage;

/** Approximate tokens of a message: its text (or serialized parts) / `APPROX_CHARS_PER_TOKEN`. */
export function approximateTokens(content: MessageContent): number {
  const chars = typeof content === 'string' ? content.length : JSON.stringify(content).length;
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
}

/**
 * The newest messages of `history` (oldest first) that fit every limit, kept contiguous: the
 * window stops at the first message that would overflow a budget, so the oldest go first. A tool
 * call and its results are kept or dropped together: a window never opens on a tool result whose
 * call was trimmed away (and the results of a kept call are newer than it, so kept with it).
 */
export function historyWindow(history: readonly Message[], limits: HistoryLimits): Message[] {
  const window: Message[] = [];
  let tokens = 0;
  let chars = 0;
  for (const message of history.toReversed()) {
    if (window.length >= limits.maxMessages) break;
    const cost = approximateTokens(message.content);
    const size = aiInputChars([toModelMessage(message)]);
    if (tokens + cost > limits.maxTokens || chars + size > limits.maxChars) break;
    tokens += cost;
    chars += size;
    window.push(message);
  }
  window.reverse();
  while (window[0]?.role === 'tool') window.shift();
  return window;
}
