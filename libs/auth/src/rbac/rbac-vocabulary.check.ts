import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../auth.constants.js';
import type { PermissionRequirement } from '../decorators/require-permissions.decorator.js';
import { RbacRegistry } from './rbac.registry.js';

const requirementOf = (target: unknown): PermissionRequirement | undefined =>
  typeof target === 'function'
    ? (Reflect.getMetadata(PERMISSIONS_KEY, target) as PermissionRequirement | undefined)
    : undefined;

/**
 * Boot-time drift check: every `@RequirePermissions` / `@RequireAnyPermission` name on a controller
 * or provider (resolvers, WebSocket gateways) must be declared by some `RbacModule.forFeature`. A
 * typo or a forgotten feature fails the boot instead of silently denying every caller.
 */
@Injectable()
export class RbacVocabularyCheck implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly registry: RbacRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const undeclared = this.undeclared();
    if (undeclared.length > 0) {
      throw new Error(
        `RBAC vocabulary check failed: undeclared permission(s) ${undeclared.join('; ')}`,
      );
    }
  }

  /** `<names> (<Class>[.<method>])` for each class or method requiring an undeclared permission. */
  undeclared(): string[] {
    const found = new Set<string>();
    const wrappers = [...this.discovery.getControllers(), ...this.discovery.getProviders()];
    for (const { metatype } of wrappers) {
      if (typeof metatype !== 'function') continue;
      const prototype = (metatype as { prototype?: object }).prototype ?? null;
      this.collect(found, requirementOf(metatype), metatype.name);
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const handler: unknown = prototype === null ? undefined : Reflect.get(prototype, method);
        this.collect(found, requirementOf(handler), `${metatype.name}.${method}`);
      }
    }
    return [...found];
  }

  private collect(
    found: Set<string>,
    requirement: PermissionRequirement | undefined,
    where: string,
  ) {
    const missing = (requirement?.permissions ?? []).filter(
      (name) => !this.registry.isDeclared(name),
    );
    if (missing.length > 0) found.add(`${missing.join(', ')} (${where})`);
  }
}
