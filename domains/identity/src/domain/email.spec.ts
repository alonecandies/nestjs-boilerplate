import { describe, expect, it } from 'vitest';
import { normalizeEmail } from './email.js';

describe('normalizeEmail', () => {
  it('trims and lower-cases: the canonical form users.email stores', () => {
    expect(normalizeEmail('  Ada.Lovelace@Example.COM ')).toBe('ada.lovelace@example.com');
  });

  it('is idempotent', () => {
    expect(normalizeEmail(normalizeEmail(' A@B.C '))).toBe('a@b.c');
  });
});
