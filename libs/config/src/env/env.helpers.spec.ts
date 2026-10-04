import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { zBool, zCsv, zEnum, zInt, zPort, zStr, zUrl } from './env.helpers.js';
import { EnvValidationError, parseEnv } from './parse-env.js';

const parse = <T>(schema: z.ZodType<T>, value: string | undefined): T => schema.parse(value);
const fails = (schema: z.ZodType<unknown>, value: string): boolean =>
  !schema.safeParse(value).success;

describe('zBool', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['false', false],
    ['False', false],
    ['0', false],
  ])('%s → %s', (raw, expected) => {
    expect(parse(zBool(), raw)).toBe(expected);
  });

  it('applies the default when unset or empty, and rejects other words', () => {
    expect(parse(zBool(true), undefined)).toBe(true);
    expect(parse(zBool(false), '  ')).toBe(false);
    expect(parse(zBool(), undefined)).toBeUndefined();
    expect(fails(zBool(), 'yes')).toBe(true);
    expect(fails(zBool(), '2')).toBe(true);
  });
});

describe('zInt / zPort', () => {
  it('parses strict integers and applies defaults', () => {
    expect(parse(zInt(5), ' 42 ')).toBe(42);
    expect(parse(zInt(5), '-3')).toBe(-3);
    expect(parse(zInt(5), undefined)).toBe(5);
    expect(parse(zInt(5), '')).toBe(5);
    expect(parse(zInt(), undefined)).toBeUndefined();
  });

  it.each(['1.5', '1e3', '0x10', '12abc', 'NaN'])('rejects %s', (raw) => {
    expect(fails(zInt(1), raw)).toBe(true);
  });

  it('enforces bounds and port range', () => {
    expect(fails(zInt(1, { min: 1 }), '0')).toBe(true);
    expect(fails(zInt(1, { max: 10 }), '11')).toBe(true);
    expect(parse(zPort(3000), '0')).toBe(0);
    expect(fails(zPort(3000), '65536')).toBe(true);
  });
});

describe('zCsv', () => {
  it('trims, drops empties and de-duplicates', () => {
    expect(parse(zCsv(), ' a, b,,a , c ')).toEqual(['a', 'b', 'c']);
  });

  it('uses the (string or array) default and never shares the default array', () => {
    const schema = zCsv('x,y');
    const first = parse(schema, undefined);
    expect(first).toEqual(['x', 'y']);
    first.push('mutated');
    expect(parse(schema, undefined)).toEqual(['x', 'y']);
    expect(parse(zCsv(['z']), '')).toEqual(['z']);
    expect(parse(zCsv(), undefined)).toEqual([]);
  });

  it('can require at least one entry', () => {
    expect(fails(zCsv('a', { nonEmpty: true }), ' , ')).toBe(true);
  });
});

describe('zStr / zUrl / zEnum', () => {
  it('zStr trims, treats blank as unset and checks patterns', () => {
    expect(parse(zStr('d'), '  v  ')).toBe('v');
    expect(parse(zStr('d'), '   ')).toBe('d');
    expect(parse(zStr(), '')).toBeUndefined();
    expect(fails(zStr('x', { min: 5 }), 'abc')).toBe(true);
    expect(fails(zStr('ok', { pattern: /^[a-z]+$/ }), 'NOPE')).toBe(true);
  });

  it('zUrl validates URLs and protocols', () => {
    expect(parse(zUrl('redis://localhost:6379', /^rediss?$/), 'rediss://cache:6380')).toBe(
      'rediss://cache:6380',
    );
    expect(fails(zUrl('redis://x', /^rediss?$/), 'http://x')).toBe(true);
    expect(fails(zUrl(), 'not a url')).toBe(true);
  });

  it('zEnum accepts listed values only', () => {
    const levels = ['a', 'b'] as const;
    expect(parse(zEnum(levels, 'a'), undefined)).toBe('a');
    expect(parse(zEnum(levels), 'b')).toBe('b');
    expect(fails(zEnum(levels), 'c')).toBe(true);
  });

  it('keeps precise output types', () => {
    expectTypeOf(zBool()).toEqualTypeOf<z.ZodType<boolean | undefined>>();
    expectTypeOf(zInt(1)).toEqualTypeOf<z.ZodType<number>>();
    expectTypeOf(zEnum(['x', 'y'] as const, 'x')).toEqualTypeOf<z.ZodType<'x' | 'y'>>();
  });
});

describe('parseEnv', () => {
  const schema = z
    .object({ PORT: zPort(3000), SECRET: zStr(undefined, { min: 8 }), FLAG: zBool(false) })
    .transform((env) => ({ port: env.PORT, secret: env.SECRET, flag: env.FLAG }));

  it('returns the transformed (camelCase) output', () => {
    expect(parseEnv('demo', schema, { PORT: '8080', FLAG: '1' })).toEqual({
      port: 8080,
      secret: undefined,
      flag: true,
    });
  });

  it('throws an EnvValidationError naming every invalid variable (never its value)', () => {
    const run = () => parseEnv('demo', schema, { PORT: 'http', SECRET: 'hunter2', FLAG: 'maybe' });
    expect(run).toThrow(EnvValidationError);
    try {
      run();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/^Invalid environment for "demo":\n/);
      expect(message).toContain('→ at PORT');
      expect(message).toContain('→ at SECRET');
      expect(message).toContain('→ at FLAG');
      expect(message).not.toContain('hunter2');
      expect((error as EnvValidationError).namespace).toBe('demo');
      expect((error as EnvValidationError).issues).toHaveLength(3);
    }
  });
});
