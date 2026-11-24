import type { ModuleRef } from '@nestjs/core';
import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception.js';
import { MAINTENANCE_MODE } from '../constants/tokens.constants.js';
import { isMaintenanceEnabled, type MaintenanceModeSwitch } from './maintenance-mode.middleware.js';

/**
 * Reads the app's `MAINTENANCE_MODE` switch at run time, from any module: the switch is provided
 * only in the root module (`provideCommonEnhancers*`), so an `@Optional()` injection elsewhere
 * gets `undefined` and silently reads off. The token is looked up across modules
 * (`ModuleRef.get(…, { strict: false })`) at the first read, never at construction, and the
 * switch (not its value) is kept: a function is called again at every read, so a runtime toggle
 * is followed as the HTTP middleware follows it.
 *
 * An app that provides no switch (a service, a unit spec) reads off. A read before the switch is
 * built (during bootstrap) reads off and looks it up again next time.
 */
export function createMaintenanceModeReader(moduleRef: ModuleRef): () => boolean {
  let found: { mode: MaintenanceModeSwitch | undefined } | undefined;
  return () => {
    found ??= lookUpSwitch(moduleRef);
    return isMaintenanceEnabled(found?.mode);
  };
}

function lookUpSwitch(
  moduleRef: ModuleRef,
): { mode: MaintenanceModeSwitch | undefined } | undefined {
  let mode: MaintenanceModeSwitch | undefined;
  try {
    mode = moduleRef.get<MaintenanceModeSwitch | undefined>(MAINTENANCE_MODE, { strict: false });
  } catch (error) {
    // Only "no such provider in this app" means off for good; anything else is a real fault.
    if (error instanceof UnknownElementException) return { mode: undefined };
    throw error;
  }
  return mode === undefined ? undefined : { mode };
}
