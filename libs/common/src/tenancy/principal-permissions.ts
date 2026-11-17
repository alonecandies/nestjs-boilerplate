import type { Principal } from './principal.js';

/**
 * The permissions a principal holds, recomputed from its tenant roles (spec §7: roles travel,
 * permissions never do). An abstract class so it is its own DI token: `RbacModule.forRoot()` binds
 * it from the RBAC registry, and `@platform/database`'s `RlsElevation` asks it before elevating
 * without depending on `@platform/auth`. A tenant-less principal holds none.
 */
export abstract class PrincipalPermissions {
  abstract of(principal: Principal): readonly string[];
}
