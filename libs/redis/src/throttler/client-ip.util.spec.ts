import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createClientIpResolver } from './client-ip.util.js';

const request = (remoteAddress: string, forwardedFor?: string): IncomingMessage =>
  ({
    socket: { remoteAddress },
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  }) as unknown as IncomingMessage;

describe('createClientIpResolver', () => {
  it('TRUST_PROXY=false ignores X-Forwarded-For (no spoofing)', () => {
    expect(createClientIpResolver(false)(request('10.0.0.5', '1.2.3.4'))).toBe('10.0.0.5');
  });

  it('a trusted CIDR only honours the hop the proxy appended', () => {
    const resolve = createClientIpResolver(['10.0.0.0/8']);
    expect(resolve(request('10.0.0.5', '6.6.6.6, 1.2.3.4'))).toBe('1.2.3.4');
    expect(resolve(request('8.8.8.8', '1.2.3.4'))).toBe('8.8.8.8'); // untrusted peer
  });

  it('accepts the proxy-addr presets', () => {
    expect(createClientIpResolver(['loopback'])(request('127.0.0.1', '1.2.3.4'))).toBe('1.2.3.4');
  });

  it('TRUST_PROXY=true takes the leftmost address', () => {
    expect(createClientIpResolver(true)(request('10.0.0.5', '1.2.3.4, 10.0.0.9'))).toBe('1.2.3.4');
  });

  it('returns undefined without a request or socket address', () => {
    const resolve = createClientIpResolver(false);
    expect(resolve(undefined)).toBeUndefined();
    expect(resolve({ socket: {}, headers: {} } as unknown as IncomingMessage)).toBeUndefined();
  });

  it('treats an empty list as "trust nobody"', () => {
    expect(createClientIpResolver([])(request('10.0.0.5', '1.2.3.4'))).toBe('10.0.0.5');
  });
});
