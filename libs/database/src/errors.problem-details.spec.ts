import { toProblemDetails } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { RlsContextError } from './rls/rls-context.js';
import { RowCountMismatchError } from './rls/row-count.js';
import { SystemDatabaseError } from './system/system-database.js';

/*
 * The real database errors through the shared mapper of every transport (`toProblemDetails`,
 * @platform/common, which matches them by `name` and `code`): B3 final review F5. The gRPC side
 * (`exceptionToGrpcError`) uses the same translation.
 */
describe('database errors in problem details', () => {
  const problem = (error: Error) => toProblemDetails(error, { exposeInternal: false });

  it.each([
    [new RlsContextError('RLS_NO_PRINCIPAL', 'RLS context: no principal in CLS'), 500, 'INTERNAL'],
    [new RlsContextError('RLS_PLATFORM_TENANT', 'RLS context: platform tenant'), 403, 'FORBIDDEN'],
    [new RowCountMismatchError(1, 0, 'memberships.updateRoles'), 500, 'INTERNAL'],
    [
      new SystemDatabaseError('SYSTEM_DATABASE_UNAVAILABLE', 'System method x: no system pool'),
      503,
      'SYSTEM_DATABASE_UNAVAILABLE',
    ],
  ])('%s → %i %s, without the internal message', (error, status, code) => {
    const body = problem(error);
    expect(body).toMatchObject({ status, code });
    expect(body.detail).not.toBe(error.message);
    expect(JSON.stringify(body)).not.toMatch(/RLS context|memberships\.|System method/);
  });

  it.each([
    new RlsContextError('RLS_CONTEXT_STALE', 'RLS context: stale'),
    new RlsContextError('RLS_NO_TRANSACTION', 'RLS: no transaction'),
    new RlsContextError('RLS_INVALID_USER_ID', 'RLS context: userId is not a user UUID'),
    new SystemDatabaseError('SYSTEM_CONTEXT_REQUIRED', 'System method x outside SystemContext'),
  ])('%s stays a 500 INTERNAL', (error) => {
    expect(problem(error)).toMatchObject({ status: 500, code: 'INTERNAL' });
  });
});
