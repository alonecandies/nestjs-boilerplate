import { describe, expect, it } from 'vitest';
import { createStandaloneLogger } from './standalone-logger.js';

describe('createStandaloneLogger', () => {
  it('builds a Nest LoggerService over pino without a Nest application', () => {
    const logger = createStandaloneLogger('Cluster', { LOG_LEVEL: 'silent', NODE_ENV: 'test' });
    expect(() => {
      logger.log('primary started');
      logger.warn('worker exited', 'OverriddenContext');
      logger.error(new Error('boom'));
      logger.fatal?.('fatal');
    }).not.toThrow();
  });

  it('validates the environment like the app does', () => {
    expect(() => createStandaloneLogger('Cluster', { LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });
});
