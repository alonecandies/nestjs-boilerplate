import { describe, expect, it } from 'vitest';
import { credentialFrom, credentialHash, normalizeCredential } from './credential-tracker.util.js';

describe('credential tracker', () => {
  it('normalises case, whitespace and Unicode compatibility forms', () => {
    expect(normalizeCredential('  Alice@Example.COM ')).toBe('alice@example.com');
    expect(normalizeCredential('ａｌｉｃｅ@example.com')).toBe('alice@example.com'); // full-width → NFKC
    expect(credentialHash('Alice@Example.com')).toBe(credentialHash(' alice@example.com'));
    expect(credentialHash('alice@example.com')).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([undefined, null, 42, ['a@b.c', 'x@y.z'], { $ne: '' }, '', '   ', 'a'.repeat(321)])(
    'maps a missing or non-string credential (%j) to the shared "none" tracker',
    (value) => {
      expect(normalizeCredential(value)).toBeUndefined();
      expect(credentialHash(value)).toBe('none');
    },
  );

  it('reads the field from an HTTP body or GraphQL args ({ input } or flat)', () => {
    expect(credentialFrom({ email: 'a@b.c' }, 'email')).toBe('a@b.c');
    expect(credentialFrom({ input: { email: 'a@b.c' } }, 'email')).toBe('a@b.c');
    expect(credentialFrom({ input: 'x' }, 'email')).toBeUndefined();
    expect(credentialFrom(undefined, 'email')).toBeUndefined();
    expect(credentialFrom('raw', 'email')).toBeUndefined();
  });
});
