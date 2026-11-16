import { Injectable } from '@nestjs/common';
import { impliedTenantRoles, isTenantRole, type TenantRole } from '@platform/common';
import { isEqual } from 'lodash-es';
import { type RbacFeature, rbacFeatureProblems } from './rbac-feature.js';

/**
 * The role → permission map, assembled at boot from every domain's `RbacModule.forFeature(…)`
 * (spec §6). Global (`RbacModule.forRoot()`, imported by `AuthModule.forRootAsync()`); permissions are
 * resolved once per request when an access token is verified.
 */
@Injectable()
export class RbacRegistry {
  private readonly features = new Map<string, RbacFeature>();
  /** permission → name of the feature that declared it. */
  private readonly owners = new Map<string, string>();
  /** role → permissions granted to it directly (not through the hierarchy). */
  private readonly direct = new Map<TenantRole, Set<string>>();

  /**
   * Adds a feature. A deep-equal re-registration is a no-op (Nest identifies dynamic modules by
   * reference, so a feature imported by two modules registers twice).
   * @throws Error on an invalid feature, a different feature under a known name, or a permission
   *   another feature already declared
   */
  register(feature: RbacFeature): void {
    const known = this.features.get(feature.name);
    if (known !== undefined) {
      if (isEqual(known, feature)) return;
      throw new Error(
        `RBAC feature "${feature.name}" is already registered with a different vocabulary`,
      );
    }
    const problems = rbacFeatureProblems(feature);
    if (problems.length > 0) {
      throw new Error(`Invalid RBAC feature "${feature.name}": ${problems.join('; ')}`);
    }
    const owned = feature.permissions.filter((permission) => this.owners.has(permission));
    if (owned.length > 0) {
      const list = owned.map(
        (permission) => `${permission} (${this.owners.get(permission) ?? 'unknown'})`,
      );
      throw new Error(
        `RBAC feature "${feature.name}" declares permissions owned by another feature: ${list.join(', ')}`,
      );
    }
    this.features.set(feature.name, feature);
    for (const permission of feature.permissions) this.owners.set(permission, feature.name);
    for (const [role, granted] of Object.entries(feature.grants)) {
      if (!isTenantRole(role)) continue;
      const set = this.direct.get(role) ?? new Set<string>();
      for (const permission of granted ?? []) set.add(permission);
      this.direct.set(role, set);
    }
  }

  isDeclared(permission: string): boolean {
    return this.owners.has(permission);
  }

  /** Every declared permission, sorted. */
  permissions(): string[] {
    return [...this.owners.keys()].sort();
  }

  /** Union of the grants of every role `roles` implies, sorted; unknown roles grant nothing. */
  resolve(roles: readonly TenantRole[]): string[] {
    const granted = new Set<string>();
    for (const role of roles) {
      if (!isTenantRole(role)) continue;
      for (const implied of impliedTenantRoles(role)) {
        for (const permission of this.direct.get(implied) ?? []) granted.add(permission);
      }
    }
    return [...granted].sort();
  }
}
