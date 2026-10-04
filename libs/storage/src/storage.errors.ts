import { ExternalServiceException } from '@app/common';
import { includes, isObject, isString } from 'lodash-es';

export const STORAGE_ERROR = 'STORAGE_ERROR';

const NETWORK_ERROR_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'];

/** Node socket-level failure talking to the storage endpoint (not a client/stream problem). */
export function isNetworkError(error: unknown): boolean {
  if (!isObject(error)) return false;
  const code = (error as { code?: unknown }).code;
  return isString(code) && includes(NETWORK_ERROR_CODES, code);
}

/**
 * Wraps an SDK/network failure as a 502 `ExternalServiceException` (generic message — SDK messages
 * name buckets/endpoints). Anything else (e.g. `PayloadTooLargeException` raised by the multipart
 * stream a client is uploading, or a `DomainException`) is returned unchanged so it keeps its
 * own status.
 */
export function toStorageException(
  error: unknown,
  operation: string,
  isSdkError: (error: unknown) => boolean,
): unknown {
  if (!isSdkError(error) && !isNetworkError(error)) return error;
  return new ExternalServiceException('Object storage request failed', {
    code: STORAGE_ERROR,
    cause: error,
    details: { operation },
  });
}
