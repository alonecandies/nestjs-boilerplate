import { describe, expect, it } from 'vitest';
import { maskEmail, normalizeEmail, toSafeFilename } from './string.util.js';

describe('string utils', () => {
  it('normalizeEmail trims and lower-cases', () => {
    expect(normalizeEmail('  Ada.Lovelace@Example.COM ')).toBe('ada.lovelace@example.com');
  });

  it.each([
    ['john.doe@example.com', 'j******e@example.com'],
    ['ab@example.com', 'a*@example.com'],
    ['a@example.com', 'a*@example.com'],
    ['not-an-email', 'n**********l'],
  ])('maskEmail(%s) → %s', (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });

  it.each([
    ['My Résumé (Final).PDF', 'my-resume-final.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\Holiday Photo 01.JPEG', 'holiday-photo-01.jpeg'],
    ['.env', 'env'],
    ['文件.txt', 'file.txt'],
    ['', 'file'],
    ['archive.tar.gz', 'archive-tar.gz'],
  ])('toSafeFilename(%j) → %s', (input, expected) => {
    expect(toSafeFilename(input)).toBe(expected);
  });

  it('caps the length but keeps the extension', () => {
    const safe = toSafeFilename(`${'very long name '.repeat(20)}.png`, 40);
    expect(safe.length).toBeLessThanOrEqual(40);
    expect(safe.endsWith('.png')).toBe(true);
    expect(safe).not.toMatch(/-\.png$/);
  });
});
