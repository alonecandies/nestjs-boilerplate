import { createCache } from 'cache-manager';
import { Keyv } from 'keyv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoundedTtlKeyv, capTtl, createL1Store } from './bounded-ttl-keyv.js';

describe('capTtl', () => {
  it('never exceeds the cap and never returns "no expiry"', () => {
    expect(capTtl(500, 1_000)).toBe(500);
    expect(capTtl(60_000, 1_000)).toBe(1_000);
    expect(capTtl(undefined, 1_000)).toBe(1_000);
    expect(capTtl(0, 1_000)).toBe(1_000);
    expect(capTtl(-1, 1_000)).toBe(1_000);
  });
});

describe('BoundedTtlKeyv (L1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps set() and setMany() TTLs', async () => {
    const l1 = createL1Store({ ttlMs: 1_000, maxItems: 10 });
    expect(l1).toBeInstanceOf(BoundedTtlKeyv);
    await l1.set('a', { n: 1 }, 60_000);
    await l1.setMany([
      { key: 'b', value: 2, ttl: 60_000 },
      { key: 'c', value: 3 },
    ]);
    vi.advanceTimersByTime(999);
    await expect(l1.get('a')).resolves.toEqual({ n: 1 });
    await expect(l1.get('b')).resolves.toBe(2);
    vi.advanceTimersByTime(2);
    await expect(l1.get('a')).resolves.toBeUndefined();
    await expect(l1.get('b')).resolves.toBeUndefined();
    await expect(l1.get('c')).resolves.toBeUndefined();
  });

  it('stores live objects (no JSON round-trip) and bounds size with LRU eviction', async () => {
    const l1 = createL1Store({ ttlMs: 10_000, maxItems: 2 });
    const date = new Date(0);
    await l1.set('d', date);
    await expect(l1.get('d')).resolves.toBeInstanceOf(Date);
    await l1.set('e', 1);
    await l1.set('f', 2);
    await expect(l1.get('d')).resolves.toBeUndefined();
  });

  it('keeps L1 short-lived behind cache-manager, which passes the L2 TTL to every tier', async () => {
    const l1 = createL1Store({ ttlMs: 1_000, maxItems: 100 });
    const l2 = new Keyv();
    const cache = createCache({ stores: [l1, l2], ttl: 30_000 });
    await cache.set('k', 'v');

    vi.advanceTimersByTime(1_500);
    await expect(l1.get('k')).resolves.toBeUndefined(); // L1 copy expired
    await expect(l2.get('k')).resolves.toBe('v'); // L2 still valid
    const loader = vi.fn(async () => 'fresh');
    await expect(cache.wrap('k', loader)).resolves.toBe('v'); // served from L2 …
    expect(loader).not.toHaveBeenCalled();
    await expect(l1.get('k')).resolves.toBe('v'); // … and back-filled into L1 (capped again)
    vi.advanceTimersByTime(1_001);
    await expect(l1.get('k')).resolves.toBeUndefined();
  });
});
