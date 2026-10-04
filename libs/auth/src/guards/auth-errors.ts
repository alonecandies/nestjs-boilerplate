import { DomainException, UnauthenticatedException } from '@app/common';
import { AuthErrorCode } from '../auth.constants.js';
import { toUnauthenticated } from '../tokens/token.service.js';

/**
 * Translates a passport outcome into our error model. `err` = the strategy threw (our own
 * DomainExceptions pass through untouched); otherwise `info` explains why no user was produced:
 * a jsonwebtoken error (expired / invalid), passport-local's "Missing credentials", or nothing
 * specific → `fallback` (e.g. passport-jwt's "No auth token").
 */
export function passportFailure(
  err: unknown,
  info: unknown,
  fallback: () => UnauthenticatedException,
): DomainException {
  if (err instanceof DomainException) return err;
  if (err) return toUnauthenticated(err);
  // jsonwebtoken errors carry a specific name (TokenExpiredError, JsonWebTokenError…).
  if (info instanceof Error && info.name !== 'Error') return toUnauthenticated(info);
  if (readMessage(info) === 'Missing credentials') {
    return new UnauthenticatedException('Missing credentials', {
      code: AuthErrorCode.MISSING_CREDENTIALS,
    });
  }
  return fallback();
}

function readMessage(info: unknown): string | undefined {
  if (typeof info !== 'object' || info === null) return undefined;
  const message: unknown = Reflect.get(info, 'message');
  return typeof message === 'string' ? message : undefined;
}
