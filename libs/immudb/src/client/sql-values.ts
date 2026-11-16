import { NullValue } from '../generated/google/protobuf/struct.pb.js';
import type { NamedParam, SQLQueryResult, SQLValue } from '../generated/immudb/schema/schema.pb.js';
import type { ImmudbParams, ImmudbRow, ImmudbValue } from '../immudb.types.js';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

export function toSqlValue(value: ImmudbValue): SQLValue {
  if (value === null) return { value: { $case: 'null', value: NullValue.NULL_VALUE } };
  if (typeof value === 'string') return { value: { $case: 's', value } };
  if (typeof value === 'boolean') return { value: { $case: 'b', value } };
  if (typeof value === 'bigint') {
    if (value < INT64_MIN || value > INT64_MAX) {
      throw new RangeError(`${value} is outside the int64 range of an immudb INTEGER`);
    }
    return { value: { $case: 'n', value: value.toString() } };
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new TypeError('Invalid Date bound to an immudb TIMESTAMP');
    return { value: { $case: 'ts', value: (BigInt(ms) * 1_000n).toString() } };
  }
  return { value: { $case: 'bs', value: Buffer.from(value) } };
}

export function fromSqlValue(value: SQLValue | undefined): ImmudbValue {
  const v = value?.value;
  switch (v?.$case) {
    case undefined:
    case 'null':
      return null;
    case 'n':
      return BigInt(v.value);
    case 's':
    case 'b':
      return v.value;
    case 'bs':
      return v.value;
    case 'ts':
      return new Date(Number(BigInt(v.value) / 1_000n));
    case 'f':
      throw new TypeError('FLOAT columns are not supported by @platform/immudb');
  }
}

export function toNamedParams(params: ImmudbParams = {}): NamedParam[] {
  return Object.entries(params).map(([name, value]) => ({ name, value: toSqlValue(value) }));
}

/**
 * Result columns come back as selectors `(table.col)` (`EncodeSelector`, `ColDescriptor.Selector`):
 * plain and aliased columns map to the bare name. An unaliased aggregate comes back as
 * `(table.colN)` (N = its position, v1.9DOM.1 `proj_row_reader.go` `Columns`), so always alias
 * computed columns (`SUM(debit) AS debit_total`).
 */
export function columnKey(selector: string): string {
  const plain = /^\(([^()]+)\)$/.exec(selector);
  if (plain?.[1] === undefined) return selector;
  return plain[1].slice(plain[1].lastIndexOf('.') + 1);
}

/** Flattens the streamed `TxSQLQuery` chunks into row objects. */
export function rowsOf(results: readonly SQLQueryResult[]): ImmudbRow[] {
  const rows: ImmudbRow[] = [];
  for (const result of results) {
    for (const row of result.rows) {
      const out: ImmudbRow = {};
      row.columns.forEach((selector, i) => {
        const key = columnKey(selector);
        if (Object.hasOwn(out, key)) {
          throw new Error(`Result column "${key}" appears twice: alias it in the SELECT`);
        }
        out[key] = fromSqlValue(row.values[i]);
      });
      rows.push(out);
    }
  }
  return rows;
}
