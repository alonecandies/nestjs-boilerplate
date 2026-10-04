import { describe, expect, it } from 'vitest';
import { GRAPHQL_SCALAR_RESOLVERS, GraphQLJSONObject, GraphQLUUID } from './index.js';

describe('scalars', () => {
  it('exposes UUID and JSONObject under their schema names', () => {
    expect(GraphQLUUID.name).toBe('UUID');
    expect(GraphQLJSONObject.name).toBe('JSONObject');
    expect(Object.keys(GRAPHQL_SCALAR_RESOLVERS)).toEqual(['UUID', 'JSONObject']);
  });

  it('UUID accepts RFC 9562 ids (incl. v7) and rejects garbage', () => {
    const id = '0199a3c1-7b2e-7cc0-8f1e-2f7c3b4d5e6f';

    expect(GraphQLUUID.coerceInputValue(id)).toBe(id);
    expect(() => GraphQLUUID.coerceInputValue('not-a-uuid')).toThrow('not a valid UUID');
  });

  it('JSONObject accepts objects only', () => {
    expect(GraphQLJSONObject.coerceInputValue({ a: 1, nested: { b: [1, 2] } })).toEqual({
      a: 1,
      nested: { b: [1, 2] },
    });
    expect(() => GraphQLJSONObject.coerceInputValue([1, 2])).toThrow('non-object value');
    expect(() => GraphQLJSONObject.coerceInputValue('x')).toThrow('non-object value');
  });
});
