import { describe, expect, it } from 'vitest';
import { type RateLimitPolicy, RateLimitPolicyRegistry } from './rate-limit-policy.js';

const policy = (overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy => ({
  name: 'files.upload',
  key: 'user',
  limit: 5,
  ttlMs: 60_000,
  ...overrides,
});

describe('RateLimitPolicyRegistry', () => {
  it('registers, resolves and lists policies', () => {
    const registry = new RateLimitPolicyRegistry();
    registry.register([policy(), policy({ name: 'orders.credentials', key: 'credentials' })]);
    expect(registry.get('files.upload')).toMatchObject({ limit: 5, ttlMs: 60_000 });
    expect(registry.require('orders.credentials').key).toBe('credentials');
    expect(registry.names()).toEqual(['files.upload', 'orders.credentials']);
    expect(registry.get('nope.nope')).toBeUndefined();
    expect(() => registry.require('nope.nope')).toThrow('Unknown rate-limit policy "nope.nope"');
  });

  it('freezes registered policies', () => {
    const registry = new RateLimitPolicyRegistry();
    registry.register([policy()]);
    expect(Object.isFrozen(registry.require('files.upload'))).toBe(true);
  });

  it('rejects a duplicate name', () => {
    const registry = new RateLimitPolicyRegistry();
    registry.register([policy()]);
    expect(() => registry.register([policy()])).toThrow('registered twice');
  });

  it.each([
    [{ name: 'upload' }, 'name must look like'],
    [{ name: 'Files.Upload' }, 'name must look like'],
    [{ limit: 0 }, 'limit must be an integer >= 1'],
    [{ limit: 1.5 }, 'limit must be an integer >= 1'],
    [{ ttlMs: 0 }, 'ttlMs must be an integer >= 1'],
    [{ blockMs: -1 }, 'blockMs must be an integer >= 0'],
    [{ lockout: { threshold: 3, durationMs: 1_000 } }, 'need key "credentials"'],
    [{ credentialField: 'email' }, 'need key "credentials"'],
    [{ key: 'credentials', lockout: { threshold: 0, durationMs: 1_000 } }, 'lockout threshold'],
  ] as const)('rejects %j', (overrides, message) => {
    const registry = new RateLimitPolicyRegistry();
    expect(() => registry.register([policy(overrides as Partial<RateLimitPolicy>)])).toThrow(
      message,
    );
  });
});
