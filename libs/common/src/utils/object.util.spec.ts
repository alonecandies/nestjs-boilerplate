import { describe, expect, it } from 'vitest';
import {
  compactObject,
  deepFreeze,
  pickDefined,
  toCamelCaseKeys,
  toSnakeCaseKeys,
} from './object.util.js';

describe('object utils', () => {
  it('compactObject drops null and undefined, keeps falsy values', () => {
    expect(compactObject({ a: 1, b: null, c: undefined, d: 0, e: '', f: false })).toEqual({
      a: 1,
      d: 0,
      e: '',
      f: false,
    });
  });

  it('pickDefined keeps null (PATCH "clear") but drops undefined ("not sent")', () => {
    expect(pickDefined({ name: undefined, bio: null, age: 3 })).toEqual({ bio: null, age: 3 });
  });

  it('converts key casing shallowly by default', () => {
    const date = new Date(0);
    const input = { displayName: 'Ada', createdAt: date, nestedValue: { innerKey: 1 } };
    expect(toSnakeCaseKeys(input)).toEqual({
      display_name: 'Ada',
      created_at: date,
      nested_value: { innerKey: 1 },
    });
    expect(toCamelCaseKeys({ display_name: 'Ada' })).toEqual({ displayName: 'Ada' });
  });

  it('converts nested objects and arrays with { deep: true } without touching Dates', () => {
    const date = new Date(0);
    const result = toCamelCaseKeys(
      { user_list: [{ first_name: 'A', meta_data: { created_at: date } }] },
      { deep: true },
    );
    expect(result).toEqual({ userList: [{ firstName: 'A', metaData: { createdAt: date } }] });
    expect((result['userList'] as { metaData: { createdAt: Date } }[])[0]?.metaData.createdAt).toBe(
      date,
    );
  });

  it('deepFreeze freezes nested plain data and tolerates cycles', () => {
    const cyclic: { list: number[]; child: { value: number }; self?: unknown } = {
      list: [1, 2],
      child: { value: 1 },
    };
    cyclic.self = cyclic;
    const frozen = deepFreeze(cyclic);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.list)).toBe(true);
    expect(Object.isFrozen(frozen.child)).toBe(true);
    expect(() => {
      (frozen.child as { value: number }).value = 2;
    }).toThrow(TypeError);
  });
});
