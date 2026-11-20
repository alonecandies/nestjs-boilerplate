import { describe, expect, it } from 'vitest';
import { makeConversation, makeMessage } from '../testing/ai-fixtures.js';
import { approximateTokens, historyWindow } from './history-window.js';

const conversation = makeConversation({ tenantId: 't-1', userId: 'u-1' });
const text = (content: string, role: 'user' | 'assistant' | 'tool' = 'user') =>
  makeMessage(conversation, { content, role });

describe('historyWindow', () => {
  it('keeps the newest messages up to the count limit, oldest first', () => {
    const history = ['a', 'b', 'c', 'd'].map((c) => text(c));
    expect(
      historyWindow(history, { maxMessages: 2, maxTokens: 1_000 }).map((m) => m.content),
    ).toEqual(['c', 'd']);
  });

  it('stops at the first message that would overflow the token budget', () => {
    const history = [text('x'.repeat(40)), text('y'.repeat(8)), text('z'.repeat(8))];
    // 10 + 2 + 2 tokens: a budget of 5 keeps the two short ones only.
    expect(historyWindow(history, { maxMessages: 10, maxTokens: 5 }).map((m) => m.content)).toEqual(
      ['y'.repeat(8), 'z'.repeat(8)],
    );
    expect(historyWindow(history, { maxMessages: 10, maxTokens: 1 })).toEqual([]);
  });

  it('never opens on a tool result', () => {
    const history = [text('call', 'assistant'), text('result', 'tool'), text('next')];
    expect(
      historyWindow(history, { maxMessages: 2, maxTokens: 1_000 }).map((m) => m.content),
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
