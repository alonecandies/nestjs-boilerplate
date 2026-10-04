import cassandra from 'cassandra-driver';
import { isPlainObject, isString, pickBy } from 'lodash-es';

type Row = cassandra.types.Row;

// The driver types every cell as `any`; these readers narrow at the boundary so the rest of the
// code only sees real types.
const cell = (row: Row, column: string): unknown => row.get(column) as unknown;

const isRecord = (value: unknown): value is Record<string, unknown> => isPlainObject(value);

/** `uuid` → canonical string (the driver returns `types.Uuid`, `TimeUuid` included). */
export function uuidCell(row: Row, column: string): string {
  const value = cell(row, column);
  if (value instanceof cassandra.types.Uuid) return value.toString();
  if (isString(value)) return value;
  throw new TypeError(`Column "${column}" is not a uuid`);
}

export function textCell(row: Row, column: string): string {
  const value = cell(row, column);
  return isString(value) ? value : '';
}

export function booleanCell(row: Row, column: string): boolean {
  return cell(row, column) === true;
}

/** `timestamp` → Date (`fallback` when null). */
export function timestampCell(row: Row, column: string, fallback: () => Date): Date {
  const value = cell(row, column);
  return value instanceof Date ? value : fallback();
}

/** `map<text, text>` → plain record (an empty map is stored as null). */
export function textMapCell(row: Row, column: string): Record<string, string> {
  const value = cell(row, column);
  return isRecord(value) ? pickBy(value, isString) : {};
}
