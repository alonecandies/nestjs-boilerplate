import { describe, expect, it } from 'vitest';
import { IDENTITY_LIMITS } from '../../identity.constants.js';
import { listUsersRequestSchema } from './identity-rpc.payloads.js';

describe('listUsersRequestSchema.search', () => {
  const parse = (search: string | null | undefined) =>
    listUsersRequestSchema.safeParse({ limit: 0, search });

  it('trims; blank / null / absent → undefined (no filter)', () => {
    expect(parse(' ada ').data?.search).toBe('ada');
    for (const blank of ['', '   ', null, undefined]) {
      const result = parse(blank);
      expect(result.success).toBe(true);
      expect(result.data?.search).toBeUndefined();
    }
  });

  it(`rejects terms shorter than ${IDENTITY_LIMITS.SEARCH_MIN_LENGTH} (trigram index) or too long`, () => {
    expect(parse(' ab ').success).toBe(false);
    expect(parse('x'.repeat(IDENTITY_LIMITS.SEARCH_MAX_LENGTH + 1)).success).toBe(false);
    expect(parse('x'.repeat(IDENTITY_LIMITS.SEARCH_MAX_LENGTH)).success).toBe(true);
  });
});
