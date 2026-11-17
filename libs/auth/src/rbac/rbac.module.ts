import { type DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { type Principal, PrincipalPermissions } from '@platform/common';
import { principalPermissions } from './principal-permissions.js';
import { RbacRegistry } from './rbac.registry.js';
import type { RbacFeature } from './rbac-feature.js';
import { RbacVocabularyCheck } from './rbac-vocabulary.check.js';

const RBAC_FEATURE = Symbol('auth:rbac-feature');
const RBAC_FEATURE_REGISTRATION = Symbol('auth:rbac-feature-registration');

const registerFeature = (registry: RbacRegistry, feature: RbacFeature): RbacFeature => {
  registry.register(feature);
  return feature;
};

/** `PrincipalPermissions` (from `@platform/common`) over the registry: what `RlsElevation` asks. */
class RegistryPrincipalPermissions extends PrincipalPermissions {
  constructor(private readonly registry: RbacRegistry) {
    super();
  }

  of(principal: Principal): readonly string[] {
    return principalPermissions(this.registry, principal);
  }
}

/**
 * Open RBAC vocabulary (spec §6). `forRoot()` (global; `AuthModule.forRootAsync()` imports it) holds
 * the registry, the boot-time vocabulary check and the `PrincipalPermissions` binding (read by
 * `@platform/database`'s `RlsElevation`); each domain's Api module imports
 * `forFeature(<X>_RBAC)`. The feature itself is a `useValue` provider so that two features never
 * share a module id, whatever Nest's module-id algorithm (deep hash or reference).
 */
@Module({})
export class RbacModule {
  static forRoot(): DynamicModule {
    return {
      module: RbacModule,
      global: true,
      imports: [DiscoveryModule],
      providers: [
        RbacRegistry,
        RbacVocabularyCheck,
        {
          provide: PrincipalPermissions,
          inject: [RbacRegistry],
          useFactory: (registry: RbacRegistry): PrincipalPermissions =>
            new RegistryPrincipalPermissions(registry),
        },
      ],
      exports: [RbacRegistry, PrincipalPermissions],
    };
  }

  static forFeature(feature: RbacFeature): DynamicModule {
    return {
      module: RbacModule,
      providers: [
        { provide: RBAC_FEATURE, useValue: feature },
        {
          provide: RBAC_FEATURE_REGISTRATION,
          inject: [RbacRegistry, RBAC_FEATURE],
          useFactory: registerFeature,
        },
      ],
    };
  }
}
