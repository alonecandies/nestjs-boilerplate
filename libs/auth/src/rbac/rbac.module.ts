import { type DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { RbacRegistry } from './rbac.registry.js';
import type { RbacFeature } from './rbac-feature.js';
import { RbacVocabularyCheck } from './rbac-vocabulary.check.js';

const RBAC_FEATURE = Symbol('auth:rbac-feature');
const RBAC_FEATURE_REGISTRATION = Symbol('auth:rbac-feature-registration');

const registerFeature = (registry: RbacRegistry, feature: RbacFeature): RbacFeature => {
  registry.register(feature);
  return feature;
};

/**
 * Open RBAC vocabulary (spec §6). `forRoot()` (global; `AuthModule.forRootAsync()` imports it) holds
 * the registry and the boot-time vocabulary check; each domain's Api module imports
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
      providers: [RbacRegistry, RbacVocabularyCheck],
      exports: [RbacRegistry],
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
