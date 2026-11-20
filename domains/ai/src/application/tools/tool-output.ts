import type { JsonValue } from '../../domain/ai.types.js';

type JsonObject = { readonly [key: string]: JsonValue };

const sizeOf = (value: JsonValue): number => JSON.stringify(value).length;

const isObject = (value: JsonValue): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `value` when its JSON fits in `maxChars`; otherwise a list result (`{ items: [...] }`) keeps its
 * first items that fit and gains `truncated: true`, and anything else becomes `{ truncated: true }`.
 * The result is always JSON within the cap, so an oversize tool result never reaches the model.
 */
export function capToolOutput(value: JsonValue, maxChars: number): JsonValue {
  if (sizeOf(value) <= maxChars) return value;
  const items = isObject(value) ? value['items'] : undefined;
  if (isObject(value) && Array.isArray(items)) {
    const kept = [...(items as readonly JsonValue[])];
    while (kept.length > 0) {
      kept.pop();
      const capped: JsonObject = { ...value, items: kept, truncated: true };
      if (sizeOf(capped) <= maxChars) return capped;
    }
  }
  return { truncated: true };
}

/** `text` cut to `maxChars` characters (the last one an ellipsis when cut). */
export function clipText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}
