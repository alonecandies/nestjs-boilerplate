import { type ServiceError, status } from '@grpc/grpc-js';

export type ImmudbErrorKind =
  | 'duplicate-key'
  | 'read-conflict'
  | 'read-only'
  | 'access-denied'
  | 'tx-closed'
  | 'unavailable'
  | 'verification-failed';

/** A classified immudb failure. The server sends no error codes, so kinds come from messages. */
export class ImmudbError extends Error {
  override readonly name = 'ImmudbError';

  constructor(
    readonly kind: ImmudbErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  /** Worth a new transaction: an MVCC loser or a transport/session failure. */
  get retryable(): boolean {
    return this.kind === 'read-conflict' || this.kind === 'unavailable';
  }
}

/**
 * Server messages pinned to immudb 1.11.2 (spec appendix P2-P8); the int spec covers each one. Order
 * matters: the first match wins.
 */
const MESSAGE_KINDS: readonly (readonly [RegExp, ImmudbErrorKind])[] = [
  [/key already exists/, 'duplicate-key'],
  [/tx read conflict/, 'read-conflict'],
  [/read-only transaction/, 'read-only'],
  [/access denied/, 'access-denied'],
  [/no transaction found|no ongoing transaction/, 'tx-closed'],
  // pkg/server/sessions/errors.go ErrSessionNotFound (idle timeout, restart, closed session).
  [/no session found|session not found/, 'unavailable'],
];

function isServiceError(error: unknown): error is ServiceError {
  return error instanceof Error && typeof (error as Partial<ServiceError>).code === 'number';
}

function detailsOf(error: ServiceError): string {
  return error.details === '' ? error.message : error.details;
}

/** Classifies a gRPC error from immudb; `undefined` for anything this package does not know. */
export function toImmudbError(error: unknown): ImmudbError | undefined {
  if (error instanceof ImmudbError) return error;
  if (!isServiceError(error)) return undefined;
  const details = detailsOf(error);
  const match = MESSAGE_KINDS.find(([pattern]) => pattern.test(details));
  if (match !== undefined) return new ImmudbError(match[1], details, { cause: error });
  if (error.code === status.UNAVAILABLE || error.code === status.DEADLINE_EXCEEDED) {
    return new ImmudbError('unavailable', details, { cause: error });
  }
  return undefined;
}

/** The server no longer knows the session (idle timeout, restart): discard it, never reuse it. */
export function isSessionGone(error: unknown): boolean {
  return isServiceError(error) && /no session found|session not found/.test(detailsOf(error));
}
