import { redisConfig } from '@app/config';
import { describe, expect, it } from 'vitest';
import { hashTag, isNonEmptyString, joinKey } from './key.util.js';
import { RedisKeyService } from './redis-key.service.js';

describe('joinKey', () => {
  it('joins the prefix and segments with ":"', () => {
    expect(joinKey('app', 'auth', 'denylist', 'abc')).toBe('app:auth:denylist:abc');
    expect(joinKey('app', 'user', 42)).toBe('app:user:42');
    expect(joinKey('app')).toBe('app');
  });

  it('rejects empty prefixes and empty / non-finite segments (key collisions)', () => {
    expect(() => joinKey('', 'x')).toThrow(TypeError);
    expect(() => joinKey('app', 'a', '', 'b')).toThrow(/segment #1/);
    expect(() => joinKey('app', Number.NaN)).toThrow(TypeError);
    expect(() => joinKey('app', Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('hashTag', () => {
  it('wraps the value in a Redis Cluster hash tag', () => {
    expect(hashTag('default:abc')).toBe('{default:abc}');
    expect(hashTag(7)).toBe('{7}');
    expect(() => hashTag('')).toThrow(TypeError);
  });
});

describe('isNonEmptyString', () => {
  it.each([
    ['x', true],
    ['', false],
    [1, false],
    [undefined, false],
    [null, false],
  ])('%j -> %s', (value, expected) => {
    expect(isNonEmptyString(value)).toBe(expected);
  });
});

describe('RedisKeyService', () => {
  it('prefixes keys with REDIS_KEY_PREFIX', () => {
    const service = new RedisKeyService(redisConfig.parse({ REDIS_KEY_PREFIX: 'svc' }));
    expect(service.prefix).toBe('svc');
    expect(service.key('lock', 'identity:purge-sessions')).toBe('svc:lock:identity:purge-sessions');
  });
});
