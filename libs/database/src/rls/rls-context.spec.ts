import { createPrincipal, PLATFORM_TENANT_ID } from '@platform/common';
import { describe, expect, it } from 'vitest';
import {
  buildRlsContextSql,
  getAppliedRlsContext,
  RLS_UUID_PATTERN,
  RlsContextError,
  type RlsContextInput,
  type RlsErrorCode,
  rlsContextOf,
} from './rls-context.js';

const USER = '0197a000-0000-7000-8000-00000000000a';
const TENANT = '0197a000-0000-7000-8000-0000000000a1';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Every string the builder may return: nothing else can reach the server. */
const FULL_OUTPUT = new RegExp(
  `^SET LOCAL app\\.user_id = '${UUID}'; SET LOCAL app\\.tenant_id = '(?:${UUID})?'; ` +
    `SET LOCAL app\\.elevated = 'off'$`,
);

/** The error `build` throws, or a failure when it returns a string instead. */
function errorOf(input: unknown): RlsContextError {
  let output: string | undefined;
  try {
    output = buildRlsContextSql(input as RlsContextInput);
  } catch (error) {
    expect(error).toBeInstanceOf(RlsContextError);
    return error as RlsContextError;
  }
  throw new Error(`expected a throw, got ${JSON.stringify(output)}`);
}

const HOSTILE: readonly (readonly [label: string, value: unknown])[] = [
  ['an SQL injection', "x'; SET ROLE app_owner; --"],
  ['a UUID followed by a newline', `${USER}\n`],
  ['a UUID followed by a space', `${USER} `],
  ["a UUID followed by '--", `${USER}'--`],
  ['36 characters with a non-hex letter', '0197a000-0000-7000-8000-00000000000g'],
  ['a full-width digit', '0197a000-0000-7000-8000-00000000000１'],
  ['the empty string', ''],
  ['a number', 42],
  ['an array', [USER]],
  ['an object whose toString() returns a UUID', { toString: () => USER }],
];

describe('RLS_UUID_PATTERN', () => {
  it('is the strict UUID shape, with no flag but i', () => {
    expect(RLS_UUID_PATTERN.source).toBe(`^${UUID}$`);
    expect(RLS_UUID_PATTERN.flags).toBe('i');
  });
});

describe('buildRlsContextSql', () => {
  it('emits exactly the three SET LOCAL statements for a user and a tenant', () => {
    expect(buildRlsContextSql({ userId: USER, tenantId: TENANT })).toBe(
      `SET LOCAL app.user_id = '${USER}'; SET LOCAL app.tenant_id = '${TENANT}'; ` +
        `SET LOCAL app.elevated = 'off'`,
    );
  });

  it("emits an empty tenant for a tenant-less principal (tenantId: null → '')", () => {
    expect(buildRlsContextSql({ userId: USER, tenantId: null })).toBe(
      `SET LOCAL app.user_id = '${USER}'; SET LOCAL app.tenant_id = ''; ` +
        `SET LOCAL app.elevated = 'off'`,
    );
  });

  it('emits upper-case input lower-case', () => {
    expect(buildRlsContextSql({ userId: USER.toUpperCase(), tenantId: TENANT.toUpperCase() })).toBe(
      `SET LOCAL app.user_id = '${USER}'; SET LOCAL app.tenant_id = '${TENANT}'; ` +
        `SET LOCAL app.elevated = 'off'`,
    );
  });

  describe.each(HOSTILE)('refuses %s', (_label, value) => {
    it('as the user (RLS_INVALID_USER_ID)', () => {
      expect(errorOf({ userId: value, tenantId: TENANT }).code).toBe('RLS_INVALID_USER_ID');
    });

    it('as the tenant (RLS_INVALID_TENANT_ID)', () => {
      expect(errorOf({ userId: USER, tenantId: value }).code).toBe('RLS_INVALID_TENANT_ID');
    });
  });

  it('refuses null and undefined as the user, and undefined as the tenant', () => {
    expect(errorOf({ userId: null, tenantId: TENANT }).code).toBe('RLS_INVALID_USER_ID');
    expect(errorOf({ userId: undefined, tenantId: null }).code).toBe('RLS_INVALID_USER_ID');
    expect(errorOf({ userId: USER, tenantId: undefined }).code).toBe('RLS_INVALID_TENANT_ID');
  });

  it('refuses the nil UUID as the user (RLS_INVALID_USER_ID) and as the tenant (RLS_PLATFORM_TENANT)', () => {
    expect(errorOf({ userId: PLATFORM_TENANT_ID, tenantId: TENANT }).code).toBe(
      'RLS_INVALID_USER_ID',
    );
    expect(errorOf({ userId: USER, tenantId: PLATFORM_TENANT_ID }).code).toBe(
      'RLS_PLATFORM_TENANT',
    );
  });

  it('refuses a missing input object', () => {
    expect(errorOf(null).code).toBe('RLS_INVALID_USER_ID');
    expect(errorOf(undefined).code).toBe('RLS_INVALID_USER_ID');
  });

  it('never echoes the refused value in the message', () => {
    const error = errorOf({ userId: "x'; SET ROLE app_owner; --", tenantId: null });
    expect(error.message).not.toContain('SET ROLE');
  });

  describe('property: over 1,000 random strings it throws or returns the full-output shape', () => {
    /** mulberry32: a seeded generator, so a failure reproduces. */
    const random = (seed: number): (() => number) => {
      let state = seed;
      return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
      };
    };
    const next = random(0x5eed_b3);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const ALPHABET = [...'0123456789abcdefABCDEFg-\' ;\n\t\\"%_xX\u0000１Kıé'];
    const VALID = [USER, TENANT, USER.toUpperCase(), '0197A000-0000-7000-8000-0000000000B2'];

    /** Half free-form strings, half valid UUIDs with one edit (the "returns" branch stays hot). */
    const candidate = (): string => {
      if (next() < 0.5) {
        const length = Math.floor(next() * 48);
        return Array.from({ length }, () => pick(ALPHABET)).join('');
      }
      const chars = [...pick(VALID)];
      const at = Math.floor(next() * chars.length);
      const edit = Math.floor(next() * 4);
      if (edit === 0) chars[at] = pick(ALPHABET);
      else if (edit === 1) chars.splice(at, 0, pick(ALPHABET));
      else if (edit === 2) chars.splice(at, 1);
      else chars[at] = (chars[at] ?? '').toUpperCase();
      return chars.join('');
    };

    it('holds for the user and for the tenant position', () => {
      let returned = 0;
      let thrown = 0;
      const check = (input: RlsContextInput): void => {
        let output: string;
        try {
          output = buildRlsContextSql(input);
        } catch (error) {
          expect(error).toBeInstanceOf(RlsContextError);
          thrown += 1;
          return;
        }
        expect(output).toMatch(FULL_OUTPUT);
        returned += 1;
      };
      for (let i = 0; i < 1_000; i += 1) {
        const value = candidate();
        check({ userId: value, tenantId: null });
        check({ userId: USER, tenantId: value });
      }
      // Both branches ran: the property is not vacuous.
      expect(returned).toBeGreaterThan(50);
      expect(thrown).toBeGreaterThan(50);
    });
  });
});

describe('rlsContextOf', () => {
  it('takes the user and the tenant of a principal', () => {
    const principal = createPrincipal({ userId: USER, tenantId: TENANT, roles: ['member'] });
    expect(rlsContextOf(principal)).toEqual({ userId: USER, tenantId: TENANT });
    expect(rlsContextOf(createPrincipal({ userId: USER, tenantId: null }))).toEqual({
      userId: USER,
      tenantId: null,
    });
  });
});

describe('getAppliedRlsContext', () => {
  it('is undefined with no transaction host and no CLS context', () => {
    expect(getAppliedRlsContext()).toBeUndefined();
  });
});

describe('RlsContextError', () => {
  it('carries its code', () => {
    const code: RlsErrorCode = 'RLS_NO_PRINCIPAL';
    const error = new RlsContextError(code, 'no principal');
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'RlsContextError', code, message: 'no principal' });
  });
});
