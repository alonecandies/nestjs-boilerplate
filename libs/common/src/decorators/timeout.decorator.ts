import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import { TIMEOUT_KEY } from '../constants/metadata.constants.js';

/**
 * Overrides the default request timeout for a route or controller (read by `TimeoutInterceptor`).
 * `@Timeout(0)` disables the timeout, e.g. for long-running exports or streaming endpoints.
 *
 * NOTE: `@nestjs/schedule` also exports a `Timeout` decorator — alias one of them on import.
 */
export const Timeout = (ms: number): CustomDecorator<string> => {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`@Timeout(ms) expects a non-negative finite number, received ${ms}`);
  }
  return SetMetadata(TIMEOUT_KEY, ms);
};
