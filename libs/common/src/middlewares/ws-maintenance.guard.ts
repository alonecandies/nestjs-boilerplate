import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { maintenanceException } from './maintenance-mode.middleware.js';
import { createMaintenanceModeReader } from './maintenance-mode.reader.js';

/**
 * Refuses every WebSocket message with the maintenance 503 (`SERVICE_UNAVAILABLE`, the problem the
 * HTTP middleware sends) while the `MAINTENANCE_MODE` switch is on, read at run time
 * (`createMaintenanceModeReader`). Anything that is not a `ws` context passes.
 *
 * Put it first in a gateway's own `@UseGuards(...)` list (after the global guards, which always run
 * first), so a message is refused before the gateway's other guards spend anything. Keep it
 * gateway-scoped, never an `APP_GUARD`: with `inheritAppConfig` a global guard also wraps the
 * Kafka and gRPC handlers, which keep running during maintenance.
 */
@Injectable()
export class WsMaintenanceGuard implements CanActivate {
  private readonly maintenanceOn: () => boolean;

  constructor(@Inject(ModuleRef) moduleRef: ModuleRef) {
    this.maintenanceOn = createMaintenanceModeReader(moduleRef);
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'ws' || !this.maintenanceOn()) return true;
    throw maintenanceException();
  }
}
