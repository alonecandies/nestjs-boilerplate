import { describe, expect, it } from 'vitest';
import { randomTokenBase64Url, sha256Hex, timingSafeEqualStr } from './crypto.util.js';

describe('crypto utils', () => {
  it('sha256Hex matches the known test vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex('abc'));
  });

  it('timingSafeEqualStr compares content, including different lengths', () => {
    expect(timingSafeEqualStr('secret', 'secret')).toBe(true);
    expect(timingSafeEqualStr('secret', 'secreT')).toBe(false);
    expect(timingSafeEqualStr('secret', 'secret-longer')).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(true);
  });

  it('randomTokenBase64Url produces url-safe tokens of the requested entropy', () => {
    const token = randomTokenBase64Url();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomTokenBase64Url(16)).toHaveLength(22);
    expect(randomTokenBase64Url()).not.toBe(token);
  });
});
