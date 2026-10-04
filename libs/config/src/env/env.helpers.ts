import { compact, uniq } from 'lodash-es';
import { z } from 'zod';

/**
 * Env-var field builders. Conventions shared by all of them:
 * - an empty / whitespace-only value counts as UNSET (so `FOO=` in a .env file falls back to the
 *   default instead of failing or becoming `0`/`''`);
 * - with a default → the output is always defined; without → `T | undefined`;
 * - the input is always a string (that's what the environment holds).
 */

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const unsetAware = <T>(inner: z.ZodType<T>): z.ZodType<T> => z.preprocess(emptyToUndefined, inner);

export interface IntBounds {
  min?: number;
  max?: number;
}

/** `'true' | 'false' | '1' | '0'` (case-insensitive) → boolean. */
export function zBool(): z.ZodType<boolean | undefined>;
export function zBool(defaultValue: boolean): z.ZodType<boolean>;
export function zBool(defaultValue?: boolean): z.ZodType<boolean | undefined> {
  const bool = z.stringbool({ truthy: ['true', '1'], falsy: ['false', '0'], case: 'insensitive' });
  return unsetAware(defaultValue === undefined ? bool.optional() : bool.default(defaultValue));
}

/** Strict base-10 integer (`'12'`, `'-3'`; rejects `'1.5'`, `'1e3'`, `'0x10'`, `'12abc'`). */
export function zInt(): z.ZodType<number | undefined>;
export function zInt(defaultValue: number, bounds?: IntBounds): z.ZodType<number>;
export function zInt(defaultValue: undefined, bounds: IntBounds): z.ZodType<number | undefined>;
export function zInt(defaultValue?: number, bounds: IntBounds = {}): z.ZodType<number | undefined> {
  let num = z.number().int();
  if (bounds.min !== undefined) num = num.min(bounds.min);
  if (bounds.max !== undefined) num = num.max(bounds.max);
  const parsed = z
    .string()
    .trim()
    .regex(/^[+-]?\d+$/, { message: 'Expected an integer' })
    .transform(Number)
    .pipe(num);
  return unsetAware(defaultValue === undefined ? parsed.optional() : parsed.default(defaultValue));
}

/** TCP port `0..65535` (`0` = let the OS pick, handy in tests). */
export function zPort(): z.ZodType<number | undefined>;
export function zPort(defaultValue: number): z.ZodType<number>;
export function zPort(defaultValue?: number): z.ZodType<number | undefined> {
  return defaultValue === undefined
    ? zInt(undefined, { min: 0, max: 65_535 })
    : zInt(defaultValue, { min: 0, max: 65_535 });
}

export interface CsvOptions {
  /** Require at least one entry (e.g. Kafka brokers). */
  nonEmpty?: boolean;
}

const splitCsv = (raw: string): string[] =>
  uniq(compact(raw.split(',').map((part) => part.trim())));

/** `'a, b,,a'` → `['a', 'b']` (trimmed, empties dropped, de-duplicated). Unset → default or `[]`. */
export function zCsv(
  defaultValue: string | readonly string[] = [],
  options: CsvOptions = {},
): z.ZodType<string[]> {
  const fallback = typeof defaultValue === 'string' ? splitCsv(defaultValue) : [...defaultValue];
  const items = options.nonEmpty
    ? z.array(z.string()).min(1, { message: 'Expected at least one value' })
    : z.array(z.string());
  const list = z.string().transform(splitCsv).pipe(items);
  // Factory default → every parse gets a fresh array (no shared mutable default).
  return unsetAware(list.default(() => [...fallback]));
}

export interface StrOptions {
  /** Minimum length after trimming (default 1). */
  min?: number;
  pattern?: RegExp;
  /** Message for `pattern` mismatches (never include the value — it may be a secret). */
  patternMessage?: string;
}

/** Trimmed, non-empty string. */
export function zStr(): z.ZodType<string | undefined>;
export function zStr(defaultValue: string, options?: StrOptions): z.ZodType<string>;
export function zStr(defaultValue: undefined, options: StrOptions): z.ZodType<string | undefined>;
export function zStr(
  defaultValue?: string,
  options: StrOptions = {},
): z.ZodType<string | undefined> {
  let str = z
    .string()
    .trim()
    .min(options.min ?? 1);
  if (options.pattern)
    str = str.regex(options.pattern, { message: options.patternMessage ?? 'Invalid format' });
  return unsetAware(defaultValue === undefined ? str.optional() : str.default(defaultValue));
}

/** Absolute URL, optionally restricted to protocols (e.g. `/^rediss?$/`). */
export function zUrl(): z.ZodType<string | undefined>;
export function zUrl(defaultValue: string, protocol?: RegExp): z.ZodType<string>;
export function zUrl(defaultValue: undefined, protocol: RegExp): z.ZodType<string | undefined>;
export function zUrl(defaultValue?: string, protocol?: RegExp): z.ZodType<string | undefined> {
  const url = z
    .string()
    .trim()
    .pipe(protocol ? z.url({ protocol }) : z.url());
  return unsetAware(defaultValue === undefined ? url.optional() : url.default(defaultValue));
}

/** One of a fixed set of (case-sensitive) values. */
export function zEnum<const T extends readonly [string, ...string[]]>(
  values: T,
): z.ZodType<T[number] | undefined>;
export function zEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  defaultValue: T[number],
): z.ZodType<T[number]>;
export function zEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  defaultValue?: T[number],
): z.ZodType<T[number] | undefined> {
  const schema = z.enum(values);
  return unsetAware(defaultValue === undefined ? schema.optional() : schema.default(defaultValue));
}

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

/** `NODE_ENV` field shared by every namespace that derives defaults from it. */
export const zNodeEnv = (): z.ZodType<NodeEnv> => zEnum(NODE_ENVS, 'development');

/** `SERVICE_NAME` field (identifies the process in logs, metrics, Kafka client ids…). */
export const zServiceName = (): z.ZodType<string> =>
  zStr('app', {
    pattern: /^[a-z0-9][a-z0-9._-]{0,62}$/i,
    patternMessage: 'Expected [a-z0-9._-], max 63 chars',
  });
