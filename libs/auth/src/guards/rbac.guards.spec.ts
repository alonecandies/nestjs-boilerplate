import { PermissionDeniedException, UnauthenticatedException } from '@app/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../decorators/require-permissions.decorator.js';
import { Roles } from '../decorators/roles.decorator.js';
import { Permission } from '../rbac/permission.enum.js';
import { Role } from '../rbac/role.enum.js';
import { makeAuthUser } from '../testing/auth-test.utils.js';
import { executionContext, type Transport } from './execution-context.test.js';
import { PermissionsGuard } from './permissions.guard.js';
import { RolesGuard } from './roles.guard.js';

@Roles(Role.Moderator, Role.Admin)
@RequirePermissions(Permission.UsersRead)
class UsersController {
  list(): void {
    // inherits the class-level requirements
  }

  @Roles(Role.Admin)
  @RequirePermissions(Permission.UsersManageRoles)
  updateRoles(): void {
    // handler-level metadata overrides the class
  }

  @RequireAnyPermission(Permission.FilesManage, Permission.UsersWrite)
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
  cls: abstract new (...args: never[]) => unknown = UsersController,
) => executionContext(type, { handler, cls }, { headers: {}, user });

const moderator = makeAuthUser({ roles: [Role.Moderator] });
const admin = makeAuthUser({ roles: [Role.Admin] });
const user = makeAuthUser({ roles: [Role.User] });
const { list, updateRoles, cleanup } = UsersController.prototype;

describe('RolesGuard', () => {
  it('passes when the user has ANY required role (class-level metadata)', () => {
    expect(rolesGuard.canActivate(ctx(list, moderator))).toBe(true);
    expect(rolesGuard.canActivate(ctx(list, admin))).toBe(true);
  });

  it('handler metadata overrides class metadata', () => {
    expect(() => rolesGuard.canActivate(ctx(updateRoles, moderator))).toThrow(
      PermissionDeniedException,
    );
    expect(rolesGuard.canActivate(ctx(updateRoles, admin))).toBe(true);
  });

  it('403s with the required roles, 401s without a user', () => {
    try {
      rolesGuard.canActivate(ctx(list, user));
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionDeniedException);
      expect((error as PermissionDeniedException).details).toEqual({
        requiredRoles: [Role.Moderator, Role.Admin],
      });
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
    expect(permissionsGuard.canActivate(ctx(list, moderator))).toBe(true);
    expect(() => permissionsGuard.canActivate(ctx(list, user))).toThrow(PermissionDeniedException);
    expect(() => permissionsGuard.canActivate(ctx(updateRoles, moderator))).toThrow(
      PermissionDeniedException,
    );
    expect(permissionsGuard.canActivate(ctx(updateRoles, admin))).toBe(true);
  });

  it("'any' mode: one matching permission is enough", () => {
    const custom = makeAuthUser({ permissions: [Permission.UsersWrite] });
    expect(permissionsGuard.canActivate(ctx(cleanup, custom))).toBe(true);
    try {
      permissionsGuard.canActivate(ctx(cleanup, moderator));
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as PermissionDeniedException).details).toEqual({
        requiredPermissions: [Permission.FilesManage, Permission.UsersWrite],
        mode: 'any',
      });
    }
  });

  it('works for GraphQL and WebSocket requests too', () => {
    expect(permissionsGuard.canActivate(ctx(list, admin, 'graphql'))).toBe(true);
    expect(
      permissionsGuard.canActivate(
        executionContext('ws', { handler: list, cls: UsersController }, { data: { user: admin } }),
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
