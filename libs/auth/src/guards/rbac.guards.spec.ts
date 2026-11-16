import { Reflector } from '@nestjs/core';
import { PermissionDeniedException, UnauthenticatedException } from '@platform/common';
import { describe, expect, it } from 'vitest';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../decorators/require-permissions.decorator.js';
import { Roles } from '../decorators/roles.decorator.js';
import { makeAuthUser } from '../testing/auth-test.utils.js';
import { createTestRbacRegistry, TEST_RBAC_FEATURE } from '../testing/rbac-test.utils.js';
import { executionContext, type Transport } from './execution-context.test.js';
import { PermissionsGuard } from './permissions.guard.js';
import { RolesGuard } from './roles.guard.js';

@Roles('admin')
@RequirePermissions('orders:read')
class OrdersController {
  list(): void {
    // inherits the class-level requirements
  }

  @Roles('owner')
  @RequirePermissions('orders:approve', 'alerts:write')
  approve(): void {
    // handler-level metadata overrides the class
  }

  @RequireAnyPermission('files:manage', 'orders:write')
  cleanup(): void {
    // any-of requirement
  }
}

class OpenController {
  ping(): void {
    // no requirements
  }
}

const reflector = new Reflector();
const rolesGuard = new RolesGuard(reflector);
const permissionsGuard = new PermissionsGuard(reflector);

const ctx = (
  handler: () => void,
  user?: unknown,
  type: Transport = 'http',
  cls: abstract new (...args: never[]) => unknown = OrdersController,
) => executionContext(type, { handler, cls }, { headers: {}, user });

const rbac = createTestRbacRegistry(TEST_RBAC_FEATURE);
const member = makeAuthUser({ roles: ['member'] }, rbac);
const admin = makeAuthUser({ roles: ['admin'] }, rbac);
const owner = makeAuthUser({ roles: ['owner'] }, rbac);
const { list, approve, cleanup } = OrdersController.prototype;

describe('RolesGuard', () => {
  it('passes when the user holds a required role (class-level metadata)', () => {
    expect(rolesGuard.canActivate(ctx(list, admin))).toBe(true);
  });

  it('handler metadata overrides class metadata', () => {
    expect(() => rolesGuard.canActivate(ctx(approve, admin))).toThrow(PermissionDeniedException);
    expect(rolesGuard.canActivate(ctx(approve, owner))).toBe(true);
  });

  it('403s with the required roles, 401s without a user', () => {
    try {
      rolesGuard.canActivate(ctx(list, member));
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionDeniedException);
      expect((error as PermissionDeniedException).details).toEqual({ requiredRoles: ['admin'] });
    }
    expect(() => rolesGuard.canActivate(ctx(list, undefined))).toThrow(UnauthenticatedException);
  });

  it('passes without metadata and for rpc handlers', () => {
    expect(
      rolesGuard.canActivate(ctx(OpenController.prototype.ping, undefined, 'http', OpenController)),
    ).toBe(true);
    expect(rolesGuard.canActivate(ctx(list, undefined, 'rpc'))).toBe(true);
  });
});

describe('PermissionsGuard', () => {
  it("'all' mode: every permission is required", () => {
    expect(permissionsGuard.canActivate(ctx(list, admin))).toBe(true);
    expect(() => permissionsGuard.canActivate(ctx(list, member))).toThrow(
      PermissionDeniedException,
    );
    expect(permissionsGuard.canActivate(ctx(approve, admin))).toBe(true);
    expect(() =>
      permissionsGuard.canActivate(ctx(approve, makeAuthUser({ permissions: ['orders:approve'] }))),
    ).toThrow(PermissionDeniedException);
  });

  it("'any' mode: one matching permission is enough", () => {
    const custom = makeAuthUser({ permissions: ['orders:write'] });
    expect(permissionsGuard.canActivate(ctx(cleanup, custom))).toBe(true);
    try {
      permissionsGuard.canActivate(ctx(cleanup, member));
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as PermissionDeniedException).details).toEqual({
        requiredPermissions: ['files:manage', 'orders:write'],
        mode: 'any',
      });
    }
  });

  it('works for GraphQL and WebSocket requests too', () => {
    expect(permissionsGuard.canActivate(ctx(list, admin, 'graphql'))).toBe(true);
    expect(
      permissionsGuard.canActivate(
        executionContext('ws', { handler: list, cls: OrdersController }, { data: { user: admin } }),
      ),
    ).toBe(true);
  });

  it('passes without metadata / for rpc, 401s without a user', () => {
    expect(
      permissionsGuard.canActivate(
        ctx(OpenController.prototype.ping, undefined, 'http', OpenController),
      ),
    ).toBe(true);
    expect(permissionsGuard.canActivate(ctx(list, undefined, 'rpc'))).toBe(true);
    expect(() => permissionsGuard.canActivate(ctx(list, undefined))).toThrow(
      UnauthenticatedException,
    );
  });
});

describe('RolesGuard: tenant-role hierarchy (owner ⊇ admin ⊇ member)', () => {
  @Roles('member')
  class MembersOnly {
    read(): void {
      // any member of the tenant
    }
  }
  const read = MembersOnly.prototype.read;
  const at = (user: unknown) => ctx(read, user, 'http', MembersOnly);

  it('an owner satisfies @Roles("admin"); an admin and an owner satisfy @Roles("member")', () => {
    expect(rolesGuard.canActivate(ctx(list, owner))).toBe(true);
    expect(rolesGuard.canActivate(at(admin))).toBe(true);
    expect(rolesGuard.canActivate(at(owner))).toBe(true);
    expect(rolesGuard.canActivate(at(member))).toBe(true);
  });

  it('no role at all satisfies nothing', () => {
    expect(() => rolesGuard.canActivate(at(makeAuthUser({ roles: [] })))).toThrow(
      PermissionDeniedException,
    );
  });
});
