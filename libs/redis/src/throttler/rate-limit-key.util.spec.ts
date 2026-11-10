import { describe, expect, it } from 'vitest';
import { rateLimitKey } from './rate-limit-key.util.js';

describe('rateLimitKey', () => {
  it('is a stable sha256 hex digest of throttler, scope and tracker', () => {
    const key = rateLimitKey('user', 'global', 'user:u-1');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(rateLimitKey('user', 'global', 'user:u-1')).toBe(key);
  });

  it('changes with every component and cannot be forged by moving separators', () => {
    const base = rateLimitKey('route', 'a.b', 'ip:1.2.3.4');
    expect(rateLimitKey('user', 'a.b', 'ip:1.2.3.4')).not.toBe(base);
    expect(rateLimitKey('route', 'a.c', 'ip:1.2.3.4')).not.toBe(base);
    expect(rateLimitKey('route', 'a.b', 'ip:1.2.3.5')).not.toBe(base);
    expect(rateLimitKey('a', 'b\u0000c', 'd')).not.toBe(rateLimitKey('a', 'b', 'c\u0000d'));
    expect(rateLimitKey('a', 'b","c', 'd')).not.toBe(rateLimitKey('a', 'b', 'c","d'));
  });
});
