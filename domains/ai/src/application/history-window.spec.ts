import { aiInputChars } from '@platform/ai';
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import type { Message } from '../domain/ai.types.js';
import { makeConversation, makeMessage } from '../testing/ai-fixtures.js';
import { approximateTokens, type HistoryLimits, historyWindow } from './history-window.js';

const conversation = makeConversation({ tenantId: 't-1', userId: 'u-1' });
const text = (content: string, role: 'user' | 'assistant' | 'tool' = 'user') =>
  makeMessage(conversation, { content, role });
/** No limit but `overrides`. */
const limits = (overrides: Partial<HistoryLimits>): HistoryLimits => ({
  maxMessages: 100,
  maxTokens: 100_000,
  maxChars: Number.POSITIVE_INFINITY,
  ...overrides,
});
/** A message's characters as `AiClient`'s input guard counts them. */
const charsOf = (message: Message): number =>
  aiInputChars([{ role: message.role, content: message.content } as ModelMessage]);

describe('historyWindow', () => {
  it('keeps the newest messages up to the count limit, oldest first', () => {
    const history = ['a', 'b', 'c', 'd'].map((c) => text(c));
    expect(
      historyWindow(history, limits({ maxMessages: 2, maxTokens: 1_000 })).map((m) => m.content),
    ).toEqual(['c', 'd']);
  });

  it('stops at the first message that would overflow the token budget', () => {
    const history = [text('x'.repeat(40)), text('y'.repeat(8)), text('z'.repeat(8))];
    // 10 + 2 + 2 tokens: a budget of 5 keeps the two short ones only.
    expect(
      historyWindow(history, limits({ maxMessages: 10, maxTokens: 5 })).map((m) => m.content),
    ).toEqual(['y'.repeat(8), 'z'.repeat(8)]);
    expect(historyWindow(history, limits({ maxMessages: 10, maxTokens: 1 }))).toEqual([]);
  });

  it('drops the oldest messages first to fit the input-character budget', () => {
    const history = ['a', 'b', 'c', 'd'].map((c) => text(c.repeat(10)));
    const kept = (maxChars: number) =>
      historyWindow(history, limits({ maxChars })).map((m) => m.content);
    // 10 characters each: 25 holds the two newest, 30 exactly three.
    expect(kept(25)).toEqual(['c'.repeat(10), 'd'.repeat(10)]);
    expect(kept(30)).toEqual(['b'.repeat(10), 'c'.repeat(10), 'd'.repeat(10)]);
    // The new message and the instructions took it all (or more): no history.
    expect(kept(0)).toEqual([]);
    expect(kept(-5)).toEqual([]);
  });

  it('keeps a tool call and its result together under the character budget', () => {
    const call = makeMessage(conversation, {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'call-0-0', toolName: 'get_my_profile', input: {} },
      ],
    });
    const result = makeMessage(conversation, {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-0-0',
          toolName: 'get_my_profile',
          output: { type: 'json', value: { email: 'ada@example.com' } },
        },
      ],
    });
    const answer = text('You are Ada.', 'assistant');
    const history = [text('Who am I?'), call, result, answer];
    const pair = charsOf(call) + charsOf(result) + charsOf(answer);

    // Room for the result but not its call: the result goes too.
    expect(historyWindow(history, limits({ maxChars: charsOf(result) + charsOf(answer) }))).toEqual(
      [answer],
    );
    expect(historyWindow(history, limits({ maxChars: pair - 1 }))).toEqual([answer]);
    // Room for both, measured as the guard measures (parts as JSON): kept together.
    expect(historyWindow(history, limits({ maxChars: pair }))).toEqual([call, result, answer]);
  });

  it('never opens on a tool result', () => {
    const history = [text('call', 'assistant'), text('result', 'tool'), text('next')];
    expect(
      historyWindow(history, limits({ maxMessages: 2, maxTokens: 1_000 })).map((m) => m.content),
    ).toEqual(['next']);
  });

  it('counts parts by their JSON length', () => {
    expect(approximateTokens('abcd')).toBe(1);
    expect(approximateTokens('abcde')).toBe(2);
    expect(approximateTokens([{ type: 'text', text: 'hi' }])).toBe(
      Math.ceil(JSON.stringify([{ type: 'text', text: 'hi' }]).length / 4),
    );
  });
});
