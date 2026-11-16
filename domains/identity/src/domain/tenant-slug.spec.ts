import { describe, expect, it } from 'vitest';
import { IDENTITY_LIMITS } from '../identity.constants.js';
import {
  deriveTenantSlug,
  personalWorkspaceName,
  slugify,
  TENANT_SLUG_PATTERN,
} from './tenant-slug.js';

const TENANT_A = '0190f3b2-0000-7000-8000-0000000000aa';
const TENANT_B = '0190f3b2-0000-7000-8000-0000deadbeef';

describe('tenant slugs', () => {
  it.each([
    ['Ada.Lovelace', 'ada-lovelace'],
    ['ADA', 'ada'],
    ['Zoë.Ünal', 'zoe-unal'],
    ['+++', 'workspace'],
    ['---ada---', 'ada'],
    ['', 'workspace'],
  ])('slugify(%j) = %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('caps the base at 40 characters without a trailing dash', () => {
    const slug = slugify(`${'a'.repeat(39)}.${'b'.repeat(160)}`);
    expect(slug).toBe('a'.repeat(39));
    expect(slugify('x'.repeat(200))).toHaveLength(40);
  });

  it('suffixes the last 8 hex digits of the tenant id: two users with the same local part get two slugs', () => {
    expect(deriveTenantSlug('ada', TENANT_A)).toBe('ada-000000aa');
    expect(deriveTenantSlug('ada', TENANT_B)).toBe('ada-deadbeef');
  });

  it('always yields a valid slug, whatever the email local part', () => {
    for (const base of ['+++', 'Zoë.Ünal', 'ADA', 'x'.repeat(200), '🙂', 'a_b c']) {
      expect(deriveTenantSlug(base, TENANT_B)).toMatch(TENANT_SLUG_PATTERN);
    }
    expect('-ada').not.toMatch(TENANT_SLUG_PATTERN);
    expect('ada-').not.toMatch(TENANT_SLUG_PATTERN);
    expect('Ada').not.toMatch(TENANT_SLUG_PATTERN);
  });

  it("names a personal workspace `<display name>'s workspace` within the name limit", () => {
    expect(personalWorkspaceName('  Ada  ')).toBe("Ada's workspace");
    const long = personalWorkspaceName('é'.repeat(IDENTITY_LIMITS.DISPLAY_NAME_MAX_LENGTH));
    expect(long.length).toBeLessThanOrEqual(IDENTITY_LIMITS.TENANT_NAME_MAX_LENGTH);
    expect(long.endsWith("'s workspace")).toBe(true);
  });
});
