import { EnvValidationError } from '../src/env/parse-env.js';

/** Runs `fn` and returns the `EnvValidationError` it throws; anything else fails the test. */
export function errorOf(fn: () => unknown): EnvValidationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected an EnvValidationError');
}
