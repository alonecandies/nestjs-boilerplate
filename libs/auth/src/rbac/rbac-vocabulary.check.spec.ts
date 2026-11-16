import { Controller, Get, type INestApplicationContext, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../decorators/require-permissions.decorator.js';
import { RbacModule } from './rbac.module.js';
import { RbacRegistry } from './rbac.registry.js';
import { defineRbacFeature } from './rbac-feature.js';

const ORDERS = defineRbacFeature({
  name: 'orders',
  permissions: ['orders:read', 'orders:approve'],
  grants: { member: ['orders:read'], admin: ['orders:approve'] },
});

@Controller('orders')
class OrdersController {
  @Get()
  @RequirePermissions('orders:read')
  list(): void {
    // routing only
  }

  @Get('raed')
  @RequireAnyPermission('orders:approve', 'orders:raed')
  typo(): void {
    // routing only
  }
}

@Injectable()
@RequirePermissions('shipments:track')
class ShipmentsResolver {}

const boot = async (module: new () => unknown): Promise<INestApplicationContext> =>
  NestFactory.createApplicationContext(module, { logger: false, abortOnError: false });

describe('RbacVocabularyCheck (boot-time drift check)', () => {
  let app: INestApplicationContext | undefined;
  afterEach(async () => {
    await app?.close().catch(() => undefined);
    app = undefined;
  });

  it('boots when every required permission is declared, and features registered twice stay one', async () => {
    @Controller('ok')
    class OkController {
      @Get()
      @RequirePermissions('orders:read')
      list(): void {
        // routing only
      }
    }
    @Module({ imports: [RbacModule.forFeature(ORDERS)] })
    class OrdersApi {}
    @Module({
      imports: [RbacModule.forRoot(), OrdersApi, RbacModule.forFeature(ORDERS)],
      controllers: [OkController],
    })
    class AppModule {}
    // createApplicationContext() runs init(): OnApplicationBootstrap hooks included.
    app = await boot(AppModule);
    expect(app.get(RbacRegistry).resolve(['admin'])).toEqual(['orders:approve', 'orders:read']);
  });

  it('fails the boot naming every undeclared permission and where it is required', async () => {
    @Module({
      imports: [RbacModule.forRoot(), RbacModule.forFeature(ORDERS)],
      controllers: [OrdersController],
      providers: [ShipmentsResolver],
    })
    class AppModule {}
    await expect(boot(AppModule)).rejects.toThrow(
      'RBAC vocabulary check failed: undeclared permission(s) orders:raed (OrdersController.typo); shipments:track (ShipmentsResolver)',
    );
  });

  it('registers two different features from two forFeature imports', async () => {
    const ALERTS = defineRbacFeature({
      name: 'alerts',
      permissions: ['alerts:read'],
      grants: { member: ['alerts:read'] },
    });
    @Module({
      imports: [RbacModule.forRoot(), RbacModule.forFeature(ORDERS), RbacModule.forFeature(ALERTS)],
    })
    class AppModule {}
    app = await boot(AppModule);
    expect(app.get(RbacRegistry).permissions()).toEqual([
      'alerts:read',
      'orders:approve',
      'orders:read',
    ]);
  });
});
