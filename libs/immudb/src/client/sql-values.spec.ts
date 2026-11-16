import { describe, expect, it } from 'vitest';
import { columnKey, fromSqlValue, rowsOf, toNamedParams, toSqlValue } from './sql-values.js';

describe('sql values', () => {
  it.each([
    [null, { value: { $case: 'null', value: 'NULL_VALUE' } }],
    ['a', { value: { $case: 's', value: 'a' } }],
    [9007199254740993n, { value: { $case: 'n', value: '9007199254740993' } }],
    [-1n, { value: { $case: 'n', value: '-1' } }],
    [true, { value: { $case: 'b', value: true } }],
    [new Date('2026-11-09T00:00:00.000Z'), { value: { $case: 'ts', value: '1794182400000000' } }],
  ] as const)('encodes %s', (input, expected) => {
    expect(toSqlValue(input)).toEqual(expected);
  });

  it('encodes bytes and rejects values outside int64', () => {
    expect(toSqlValue(new Uint8Array([1, 2]))).toEqual({
      value: { $case: 'bs', value: Buffer.from([1, 2]) },
    });
    expect(() => toSqlValue(2n ** 63n)).toThrow(RangeError);
    expect(() => toSqlValue(-(2n ** 63n) - 1n)).toThrow(RangeError);
    expect(() => toSqlValue(new Date(Number.NaN))).toThrow(TypeError);
  });

  it('decodes every supported case and refuses FLOAT', () => {
    expect(fromSqlValue(undefined)).toBeNull();
    expect(fromSqlValue({ value: { $case: 'n', value: '-9007199254740993' } })).toBe(
      -9007199254740993n,
    );
    expect(fromSqlValue({ value: { $case: 'ts', value: '1794182400000000' } })).toEqual(
      new Date('2026-11-09T00:00:00.000Z'),
    );
    expect(fromSqlValue({ value: { $case: 'bs', value: Buffer.from([7]) } })).toEqual(
      Buffer.from([7]),
    );
    expect(() => fromSqlValue({ value: { $case: 'f', value: 1.5 } })).toThrow(TypeError);
  });

  it('names params without the @ prefix', () => {
    expect(toNamedParams({ id: 'x' })).toEqual([
      { name: 'id', value: { value: { $case: 's', value: 'x' } } },
    ]);
    expect(toNamedParams()).toEqual([]);
  });

  it.each([
    ['(orders.id)', 'id'],
    ['(db.orders.id)', 'id'],
    ['(orders.col0)', 'col0'],
    ['(t.total)', 'total'],
    ['SUM(t.debit)', 'SUM(t.debit)'],
    ['id', 'id'],
  ])('column key of %s is %s', (selector, key) => {
    expect(columnKey(selector)).toBe(key);
  });

  it('builds row objects from streamed result chunks and refuses duplicate keys', () => {
    const chunk = {
      columns: [],
      rows: [
        {
          columns: ['(t.id)', '(t.n)'],
          values: [
            { value: { $case: 's' as const, value: 'a' } },
            { value: { $case: 'n' as const, value: '2' } },
          ],
        },
      ],
    };
    expect(rowsOf([chunk, chunk])).toEqual([
      { id: 'a', n: 2n },
      { id: 'a', n: 2n },
    ]);
    expect(() =>
      rowsOf([
        {
          columns: [],
          rows: [{ columns: ['(a.id)', '(b.id)'], values: [{}, {}] }],
        },
      ]),
    ).toThrow(/alias/);
  });
});
