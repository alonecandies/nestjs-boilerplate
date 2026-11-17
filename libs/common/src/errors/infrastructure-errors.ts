import {
  DomainConflictException,
  type DomainException,
  PermissionDeniedException,
  ServiceUnavailableException,
  UnauthenticatedException,
} from './domain.exception.js';

/** The stable code of a request that needed the `app_system` pool while none is configured. */
export const SYSTEM_DATABASE_UNAVAILABLE = 'SYSTEM_DATABASE_UNAVAILABLE';

type Translate = (cause: Error) => DomainException;

/**
 * The errors `@platform/database` throws below the domain (B3 final review F5), keyed by their
 * `name` and `code`: `@platform/common` sits below `@platform/database` and cannot import the
 * classes. Each becomes the `DomainException` a client can act on, with a fixed, client-safe
 * message (the original, which names system methods, tables and env keys, stays the `cause` for the
 * logs). Codes not listed are programming errors and stay a 500 INTERNAL:
 *
 * - `RlsContextError` RLS_NO_PRINCIPAL → 401 UNAUTHENTICATED: a unit of work opened without a
 *   principal (an unauthenticated call that reached the runtime pool);
 * - `RlsContextError` RLS_PLATFORM_TENANT → 403 FORBIDDEN: runtime data access as the platform
 *   tenant, which is never allowed; RLS_CONTEXT_STALE, RLS_NO_TRANSACTION and the invalid-id codes
 *   stay 500;
 * - `RowCountMismatchError` → 409 CONFLICT: a write that expected one row and matched none, i.e.
 *   the row changed or went away concurrently (or the policies hide it); retrying after a reload is
 *   the client's move;
 * - `SystemDatabaseError` SYSTEM_DATABASE_UNAVAILABLE → 503 SYSTEM_DATABASE_UNAVAILABLE: no system
 *   pool (DATABASE_SYSTEM_URL unset); SYSTEM_CONTEXT_REQUIRED stays 500.
 */
const TRANSLATIONS: Readonly<Record<string, Readonly<Record<string, Translate>>>> = {
  RlsContextError: {
    RLS_NO_PRINCIPAL: (cause) => new UnauthenticatedException(undefined, { cause }),
    RLS_PLATFORM_TENANT: (cause) =>
      new PermissionDeniedException('This operation is not available in the platform tenant', {
        cause,
      }),
  },
  SystemDatabaseError: {
    [SYSTEM_DATABASE_UNAVAILABLE]: (cause) =>
      new ServiceUnavailableException('A required service is temporarily unavailable', {
        code: SYSTEM_DATABASE_UNAVAILABLE,
        cause,
      }),
  },
};

const translateRowCount: Translate = (cause) =>
  new DomainConflictException(
    'The resource was changed or removed by another request; reload it and retry',
    { cause },
  );

/**
 * The `DomainException` a database error stands for, or `undefined` for anything else (unknown
 * codes included). Used by `toProblemDetails` (HTTP, GraphQL, WebSocket) and the gRPC mapping.
 */
export function translateInfrastructureError(exception: unknown): DomainException | undefined {
  if (!(exception instanceof Error)) return undefined;
  if (exception.name === 'RowCountMismatchError') return translateRowCount(exception);
  const byCode = Object.hasOwn(TRANSLATIONS, exception.name)
    ? TRANSLATIONS[exception.name]
    : undefined;
  const code = (exception as { code?: unknown }).code;
  if (byCode === undefined || typeof code !== 'string' || !Object.hasOwn(byCode, code)) {
    return undefined;
  }
  return byCode[code]?.(exception);
}
