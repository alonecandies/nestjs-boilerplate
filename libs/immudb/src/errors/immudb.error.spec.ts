import { Metadata, type ServiceError, status } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import { ImmudbError, isSessionGone, toImmudbError } from './immudb.error.js';

function serviceError(code: status, details: string): ServiceError {
  return Object.assign(new Error(`${code} ${status[code]}: ${details}`), {
    code,
    details,
    metadata: new Metadata(),
  });
}

describe('toImmudbError', () => {
  it.each([
    ['key already exists', 'duplicate-key', false],
    ['tx read conflict', 'read-conflict', true],
    ['tx read conflict: fetching more entries than expected', 'read-conflict', true],
    ['read-only transaction', 'read-only', false],
    ['access denied: statement requires [UPDATE] privileges', 'access-denied', false],
    ['no transaction found', 'tx-closed', false],
    ['no ongoing transaction', 'tx-closed', false],
    ['no session found', 'unavailable', true],
  ] as const)('maps "%s" to %s', (details, kind, retryable) => {
    const mapped = toImmudbError(serviceError(status.UNKNOWN, details));
    expect(mapped).toBeInstanceOf(ImmudbError);
    expect(mapped?.kind).toBe(kind);
    expect(mapped?.retryable).toBe(retryable);
  });

  it('maps transport failures to unavailable and leaves other errors alone', () => {
    expect(toImmudbError(serviceError(status.UNAVAILABLE, 'connect ECONNREFUSED'))?.kind).toBe(
      'unavailable',
    );
    expect(toImmudbError(serviceError(status.DEADLINE_EXCEEDED, 'deadline'))?.kind).toBe(
      'unavailable',
    );
    expect(toImmudbError(serviceError(status.UNKNOWN, 'syntax error'))).toBeUndefined();
    expect(toImmudbError(new Error('plain'))).toBeUndefined();
  });

  it('detects a session the server forgot', () => {
    expect(isSessionGone(serviceError(status.UNKNOWN, 'no session found'))).toBe(true);
    expect(isSessionGone(serviceError(status.UNKNOWN, 'key already exists'))).toBe(false);
  });
});
