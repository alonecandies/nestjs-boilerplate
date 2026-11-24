import { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception.js';
import { throttle } from 'lodash-es';
import { MAINTENANCE_MODE } from '../constants/tokens.constants.js';
import { isMaintenanceEnabled, type MaintenanceModeSwitch } from './maintenance-mode.middleware.js';

/** Minimum gap between two logged faults of one reader, so a flood of messages cannot flood the log. */
export const MAINTENANCE_SWITCH_FAULT_LOG_INTERVAL_MS = 60_000;

const logger = new Logger('MaintenanceMode');

/**
 * Reads the app's `MAINTENANCE_MODE` switch at run time, from any module: the switch is provided
 * only in the root module (`provideCommonEnhancers*`), so an `@Optional()` injection elsewhere
 * gets `undefined` and silently reads off. The token is looked up across modules
 * (`ModuleRef.get(…, { strict: false })`) at the first read, never at construction, and the
 * switch (not its value) is kept: a function is called again at every read, so a runtime toggle
 * is followed as the HTTP middleware follows it.
 *
 * An app that provides no switch (a service, a unit spec) reads off. A read before the switch is
 * built (during bootstrap, where Nest answers `null`) reads off and looks it up again next time.
 *
 * It never throws, and fails closed: a function switch that throws, or a lookup that fails for
 * any reason but "not provided", reads on (the WebSocket entry points then refuse traffic as
 * maintenance does) and is logged at most once per `MAINTENANCE_SWITCH_FAULT_LOG_INTERVAL_MS`. A
 * failed lookup is tried again at the next read. The HTTP middleware reads the switch itself, so
 * there a throwing switch is that request's 500.
 */
export function createMaintenanceModeReader(moduleRef: ModuleRef): () => boolean {
  let found: { mode: MaintenanceModeSwitch | undefined } | undefined;
  const reportFault = throttle(
    (error: unknown): void => {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error(
        `Maintenance switch unreadable, refusing WebSocket traffic as in maintenance: ${reason}`,
        error instanceof Error ? error.stack : undefined,
      );
    },
    MAINTENANCE_SWITCH_FAULT_LOG_INTERVAL_MS,
    { trailing: false },
  );
  return () => {
    try {
      found ??= lookUpSwitch(moduleRef);
      return isMaintenanceEnabled(found?.mode);
    } catch (error) {
      reportFault(error);
      return true;
    }
  };
}

function lookUpSwitch(
  moduleRef: ModuleRef,
): { mode: MaintenanceModeSwitch | undefined } | undefined {
  let mode: MaintenanceModeSwitch | null | undefined;
  try {
    mode = moduleRef.get<MaintenanceModeSwitch | null | undefined>(MAINTENANCE_MODE, {
      strict: false,
    });
  } catch (error) {
    // Only "no such provider in this app" means off for good; anything else is a fault (on).
    if (error instanceof UnknownElementException) return { mode: undefined };
    throw error;
  }
  // `null` is a provider Nest has not instantiated yet: not built, so look it up again next time.
  return mode == null ? undefined : { mode };
}
