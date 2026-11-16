import { Reflector } from '@nestjs/core';
import { PermissionDeniedException, UnauthenticatedException } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { STAFF_ONLY_KEY } from '../auth.constants.js';
import { StaffOnly } from '../decorators/staff-only.decorator.js';
import { makeAuthUser } from '../testing/auth-test.utils.js';
import { executionContext } from './execution-context.test.js';
import { StaffOnlyGuard } from './staff-only.guard.js';

class SupportController {
  @StaffOnly()
  leave(): void {
    // staff switch-in tokens only
  }
}

const guard = new StaffOnlyGuard();
const ctx = (user: unknown, type: 'http' | 'graphql' | 'ws' | 'rpc' = 'http') =>
  executionContext(
    type,
    { handler: SupportController.prototype.leave, cls: SupportController },
    type === 'ws' ? { data: { user } } : { headers: {}, user },
  );

describe('@StaffOnly / StaffOnlyGuard', () => {
  it('writes STAFF_ONLY_KEY metadata and attaches the guard', () => {
    const reflector = new Reflector();
    expect(reflector.get(STAFF_ONLY_KEY, SupportController.prototype.leave)).toBe(true);
    expect(Reflect.getMetadata('__guards__', SupportController.prototype.leave)).toContain(
      StaffOnlyGuard,
    );
  });

  it('admits a staff switch-in principal on HTTP, GraphQL and WebSocket', () => {
    const staff = makeAuthUser({ roles: ['admin'], staff: true });
    for (const type of ['http', 'graphql', 'ws'] as const) {
      expect(guard.canActivate(ctx(staff, type))).toBe(true);
    }
  });

  it('403 STAFF_ONLY for everyone else, owners included; 401 without a user', () => {
    for (const user of [makeAuthUser({ roles: ['owner'] }), makeAuthUser({ roles: ['admin'] })]) {
      try {
        guard.canActivate(ctx(user));
        throw new Error('expected a rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(PermissionDeniedException);
        expect((error as PermissionDeniedException).code).toBe('STAFF_ONLY');
      }
    }
    expect(() => guard.canActivate(ctx(undefined))).toThrow(UnauthenticatedException);
  });

  it('rpc handlers pass (services trust the edge, like RolesGuard)', () => {
    expect(guard.canActivate(ctx(undefined, 'rpc'))).toBe(true);
  });
});
