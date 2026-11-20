import { APPROX_CHARS_PER_TOKEN } from '../ai.constants.js';
import type { Message, MessageContent } from '../domain/ai.types.js';

export interface HistoryLimits {
  /** `AI_HISTORY_MAX_MESSAGES`. */
  readonly maxMessages: number;
  /** `AI_HISTORY_MAX_TOKENS` (approximate: characters / 4). */
  readonly maxTokens: number;
}

/** Approximate tokens of a message: its text (or serialized parts) / `APPROX_CHARS_PER_TOKEN`. */
export function approximateTokens(content: MessageContent): number {
  const chars = typeof content === 'string' ? content.length : JSON.stringify(content).length;
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
}

/**
 * The newest messages of `history` (oldest first) that fit both limits, kept contiguous: the
 * window stops at the first message that would overflow the token budget. A window never opens
 * on a tool result whose call was trimmed away.
 */
export function historyWindow(history: readonly Message[], limits: HistoryLimits): Message[] {
  const window: Message[] = [];
  let tokens = 0;
  for (const message of history.toReversed()) {
    if (window.length >= limits.maxMessages) break;
    const cost = approximateTokens(message.content);
    if (tokens + cost > limits.maxTokens) break;
    tokens += cost;
    window.push(message);
  }
  window.reverse();
  while (window[0]?.role === 'tool') window.shift();
  return window;
}
