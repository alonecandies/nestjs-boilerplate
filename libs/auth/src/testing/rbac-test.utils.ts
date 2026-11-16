import { RbacRegistry } from '../rbac/rbac.registry.js';
import { defineRbacFeature, type RbacFeature } from '../rbac/rbac-feature.js';

/** A registry holding `features` (specs that verify tokens or build an `AuthUser`). */
export function createTestRbacRegistry(...features: readonly RbacFeature[]): RbacRegistry {
  const registry = new RbacRegistry();
  for (const feature of features) registry.register(feature);
  return registry;
}

/** Neutral vocabulary for platform specs (libs name no domain). */
export const TEST_RBAC_FEATURE: RbacFeature = defineRbacFeature({
  name: 'test',
  permissions: [
    'alerts:read',
    'alerts:write',
    'catalog:buy',
    'catalog:read-all',
    'files:manage',
    'files:read',
    'files:write',
    'orders:approve',
    'orders:read',
    'orders:write',
  ],
  grants: {
    member: ['alerts:read', 'catalog:buy', 'files:read', 'files:write'],
    admin: [
      'alerts:write',
      'catalog:read-all',
      'files:manage',
      'orders:approve',
      'orders:read',
      'orders:write',
    ],
  },
});
