import { describe, expect, it } from 'vitest';
import { errorOf } from '../../test/error-of.js';
import { appConfig } from './app.config.js';

const parse = (env: Record<string, string> = {}) =>
  appConfig.parse({ SERVICE_NAME: 'svc', ...env });

describe('app namespace: SHUTDOWN_DRAIN_MS', () => {
  it('defaults to 0 (no drain delay)', () => {
    expect(parse().shutdownDrainMs).toBe(0);
  });

  it('reads the delay', () => {
    expect(parse({ SHUTDOWN_DRAIN_MS: '5000' }).shutdownDrainMs).toBe(5000);
  });

  it('rejects a negative or fractional value', () => {
    expect(() => parse({ SHUTDOWN_DRAIN_MS: '-1' })).toThrow();
    expect(() => parse({ SHUTDOWN_DRAIN_MS: '1.5' })).toThrow();
  });

  it('accepts a drain just below SHUTDOWN_TIMEOUT_MS', () => {
    expect(parse({ SHUTDOWN_TIMEOUT_MS: '10000', SHUTDOWN_DRAIN_MS: '9999' }).shutdownDrainMs).toBe(
      9999,
    );
  });

  it.each(['10000', '10001'])(
    'rejects a drain of %s against the default 10000 timeout',
    (drain) => {
      const error = errorOf(() => parse({ SHUTDOWN_DRAIN_MS: drain }));
      expect(error.issues.map((issue) => issue.path[0])).toEqual(['SHUTDOWN_DRAIN_MS']);
      expect(error.message).toContain('SHUTDOWN_DRAIN_MS');
      expect(error.message).toContain('SHUTDOWN_TIMEOUT_MS');
    },
  );

  it('rejects a positive drain when SHUTDOWN_TIMEOUT_MS is 0, and allows 0 with 0', () => {
    expect(() => parse({ SHUTDOWN_TIMEOUT_MS: '0', SHUTDOWN_DRAIN_MS: '1' })).toThrow();
    expect(parse({ SHUTDOWN_TIMEOUT_MS: '0', SHUTDOWN_DRAIN_MS: '0' }).shutdownDrainMs).toBe(0);
  });
});
