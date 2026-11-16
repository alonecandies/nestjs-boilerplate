import type { Principal } from '@platform/common';
import type { RbacRegistry } from './rbac.registry.js';

/**
 * Permissions of a principal, recomputed from its tenant roles through the registry. Services and
 * consumers use it: roles travel (gRPC metadata, Kafka envelopes), permissions never do (spec §7).
 */
export function principalPermissions(
  registry: RbacRegistry,
  principal: Principal | undefined,
): string[] {
  return principal === undefined || principal.tenantId === null
    ? []
    : registry.resolve(principal.roles);
}
