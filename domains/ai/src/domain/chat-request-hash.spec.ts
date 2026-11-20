import { describe, expect, it } from 'vitest';
import { chatRequestHash } from './chat-request-hash.js';

describe('chatRequestHash', () => {
  it('is a stable sha256 hex of content and model', () => {
    const hash = chatRequestHash({ content: 'Hello', model: 'mock/other' });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(chatRequestHash({ content: 'Hello', model: 'mock/other' })).toBe(hash);
  });

  it('differs when the content or the model differs, and for an absent model', () => {
    const base = chatRequestHash({ content: 'Hello', model: 'mock/other' });
    expect(chatRequestHash({ content: 'Hello!', model: 'mock/other' })).not.toBe(base);
    expect(chatRequestHash({ content: 'Hello', model: 'mock/default' })).not.toBe(base);
    expect(chatRequestHash({ content: 'Hello' })).not.toBe(base);
    expect(chatRequestHash({ content: 'Hello', model: undefined })).toBe(
      chatRequestHash({ content: 'Hello' }),
    );
  });
});
