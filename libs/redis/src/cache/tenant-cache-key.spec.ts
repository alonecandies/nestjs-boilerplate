import { describe, expect, it } from 'vitest';
import { tenantCacheKey } from './tenant-cache-key.js';

const T = '0195d6a4-8c2e-7a01-b2c3-4d5e6f708192';
const OTHER = '0195d6a4-8c2e-7a01-b2c3-4d5e6f708193';
const NIL = '00000000-0000-0000-0000-000000000000';

describe('tenantCacheKey', () => {
  it('builds <scope>:<tenantId>:<part>…', () => {
    expect(tenantCacheKey('orders', T, 'item', 7)).toBe(`orders:${T}:item:7`);
    expect(tenantCacheKey('order-lines', T, 'item')).toBe(`order-lines:${T}:item`);
  });

  it('lower-cases an upper-case tenant id', () => {
    expect(tenantCacheKey('orders', T.toUpperCase(), 'item', 7)).toBe(`orders:${T}:item:7`);
  });

  it('throws for a tenant id that is not a UUID', () => {
    expect(() => tenantCacheKey('orders', 'acme', 'item')).toThrow(TypeError);
    expect(() => tenantCacheKey('orders', '', 'item')).toThrow(TypeError);
    expect(() => tenantCacheKey('orders', `${T}:x`, 'item')).toThrow(TypeError);
  });

  it('throws for the nil UUID (the platform tenant)', () => {
    expect(() => tenantCacheKey('orders', NIL, 'item')).toThrow(TypeError);
  });

  it.each(['Orders', 'a:b', '', '1orders', 'orders_x'])('throws for the scope %j', (scope) => {
    expect(() => tenantCacheKey(scope, T, 'item')).toThrow(TypeError);
  });

  it('throws without parts', () => {
    expect(() => tenantCacheKey('orders', T)).toThrow(TypeError);
  });

  it('throws for an empty part, a part containing ":" and a non-finite number', () => {
    expect(() => tenantCacheKey('orders', T, 'item', '')).toThrow(TypeError);
    expect(() => tenantCacheKey('orders', T, 'item:7')).toThrow(TypeError);
    expect(() => tenantCacheKey('orders', T, Number.NaN)).toThrow(TypeError);
    expect(() => tenantCacheKey('orders', T, Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it('never gives two tenants the same key for equal parts', () => {
    const parts = ['item', 7] as const;
    expect(tenantCacheKey('orders', T, ...parts)).not.toBe(
      tenantCacheKey('orders', OTHER, ...parts),
    );
    expect(tenantCacheKey('orders', T, ...parts)).toBe(tenantCacheKey('orders', T, ...parts));
  });
});
