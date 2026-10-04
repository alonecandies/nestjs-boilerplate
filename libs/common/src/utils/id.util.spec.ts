import { v4 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { generateId, isSafeRequestId, isUuid, isUuidV7, uuidV7Timestamp } from './id.util.js';

describe('id utils', () => {
  it('generates time-ordered UUIDv7 ids', () => {
    const ids = Array.from({ length: 50 }, () => generateId());
    expect(ids.every((id) => isUuidV7(id))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });

  it('distinguishes uuid versions and rejects non-strings', () => {
    expect(isUuid(v4())).toBe(true);
    expect(isUuidV7(v4())).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuidV7(undefined)).toBe(false);
  });

  it('extracts the embedded timestamp of a UUIDv7', () => {
    const before = Date.now();
    const ts = uuidV7Timestamp(generateId()).getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 1);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1);
    expect(() => uuidV7Timestamp(v4())).toThrow(TypeError);
  });

  it('accepts only bounded, header-safe request ids', () => {
    expect(isSafeRequestId('req-123_abc.def:9')).toBe(true);
    expect(isSafeRequestId('')).toBe(false);
    expect(isSafeRequestId('a'.repeat(129))).toBe(false);
    expect(isSafeRequestId('evil\r\nx-injected: 1')).toBe(false);
    expect(isSafeRequestId(['a'])).toBe(false);
  });
});
