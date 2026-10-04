import {
  camelCase,
  isNil,
  isPlainObject,
  mapKeys,
  mapValues,
  omitBy,
  pickBy,
  snakeCase,
} from 'lodash-es';
import type { DeepReadonly } from '../types/utility.types.js';

/** Drops `null` and `undefined` values (shallow) — e.g. before building a DB insert or query filter. */
export function compactObject<T extends object>(obj: T): { [K in keyof T]?: NonNullable<T[K]> } {
  return omitBy(obj, isNil) as { [K in keyof T]?: NonNullable<T[K]> };
}

/**
 * Drops only `undefined` values (shallow). PATCH semantics: `undefined` = "not sent" while
 * `null` = "clear this field", so nulls must survive.
 */
export function pickDefined<T extends object>(obj: T): Partial<T> {
  return pickBy(obj, (value) => value !== undefined);
}

export interface KeyCaseOptions {
  /** Recurse into nested plain objects and arrays (Dates, Buffers, class instances are left intact). */
  deep?: boolean;
}

function transformKeys(value: unknown, mapKey: (key: string) => string, deep: boolean): unknown {
  if (deep && Array.isArray(value))
    return value.map((item: unknown) => transformKeys(item, mapKey, deep));
  if (!isPlainObject(value)) return value;
  const renamed = mapKeys(value as Record<string, unknown>, (_v, key) => mapKey(key));
  return deep ? mapValues(renamed, (v) => transformKeys(v, mapKey, deep)) : renamed;
}

/** `{ displayName: 1 }` → `{ display_name: 1 }` (shallow unless `{ deep: true }`). */
export function toSnakeCaseKeys<T extends object>(
  obj: T,
  options: KeyCaseOptions = {},
): Record<string, unknown> {
  return transformKeys(obj, snakeCase, options.deep ?? false) as Record<string, unknown>;
}

/** `{ display_name: 1 }` → `{ displayName: 1 }` (shallow unless `{ deep: true }`). */
export function toCamelCaseKeys<T extends object>(
  obj: T,
  options: KeyCaseOptions = {},
): Record<string, unknown> {
  return transformKeys(obj, camelCase, options.deep ?? false) as Record<string, unknown>;
}

/**
 * Recursively `Object.freeze`s plain objects and arrays in place (cycle-safe: already-frozen nodes
 * are skipped). Use for shared constant tables so an accidental mutation throws in strict mode.
 */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if ((isPlainObject(value) || Array.isArray(value)) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object) as unknown[]) deepFreeze(child);
  }
  return value as DeepReadonly<T>;
}
