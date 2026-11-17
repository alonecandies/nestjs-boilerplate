import { type INestApplicationContext, Inject, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createPrincipal, generateId, PrincipalPermissions } from '@platform/common';
import { afterEach, describe, expect, it } from 'vitest';
import { principalPermissions } from './principal-permissions.js';
import { RbacModule } from './rbac.module.js';
import { RbacRegistry } from './rbac.registry.js';
import { defineRbacFeature } from './rbac-feature.js';

const ORDERS = defineRbacFeature({
  name: 'orders',
  permissions: ['orders:read', 'orders:approve'],
  grants: { member: ['orders:read'], admin: ['orders:approve'] },
});

/** A consumer in another module: `forRoot()` is global, so it sees the binding without imports. */
@Injectable()
class Elevator {
  constructor(@Inject(PrincipalPermissions) readonly permissions: PrincipalPermissions) {}
}

@Module({ providers: [Elevator] })
class ElevatorModule {}

@Module({ imports: [RbacModule.forRoot(), RbacModule.forFeature(ORDERS), ElevatorModule] })
class AppModule {}

describe('RbacModule.forRoot() binds PrincipalPermissions', () => {
  let app: INestApplicationContext | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('provides PrincipalPermissions from the registry and principalPermissions(), globally', async () => {
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    const bound = app.get(Elevator).permissions;
    expect(bound).toBeInstanceOf(PrincipalPermissions);
    expect(app.get(PrincipalPermissions)).toBe(bound);

    const registry = app.get(RbacRegistry);
    const userId = generateId();
    const tenantId = generateId();
    const admin = createPrincipal({ userId, tenantId, roles: ['admin'] });
    const member = createPrincipal({ userId, tenantId, roles: ['member'] });
    const tenantless = createPrincipal({ userId, tenantId: null });

    expect(bound.of(admin)).toEqual(['orders:approve', 'orders:read']);
    expect(bound.of(admin)).toEqual(principalPermissions(registry, admin));
    expect(bound.of(member)).toEqual(['orders:read']);
    expect(bound.of(tenantless)).toEqual([]);
  });
});
