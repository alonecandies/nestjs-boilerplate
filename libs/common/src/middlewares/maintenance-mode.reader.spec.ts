import { type ExecutionContext, Inject, Injectable, Module, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { MAINTENANCE_MODE } from '../constants/tokens.constants.js';
import { ServiceUnavailableException } from '../errors/domain.exception.js';
import { toProblemDetails } from '../errors/problem-details.js';
import { provideCommonEnhancers } from '../providers/common-enhancers.js';
import type { MaintenanceModeSwitch } from './maintenance-mode.middleware.js';
import { maintenanceProblem } from './maintenance-mode.middleware.js';
import { createMaintenanceModeReader } from './maintenance-mode.reader.js';
import { WsMaintenanceGuard } from './ws-maintenance.guard.js';

/** A provider of a feature module, which is where the WebSocket entry points live. */
@Injectable()
class FeatureReader {
  readonly read: () => boolean;

  constructor(
    @Inject(ModuleRef) moduleRef: ModuleRef,
    @Optional() @Inject(MAINTENANCE_MODE) readonly injected?: MaintenanceModeSwitch,
  ) {
    this.read = createMaintenanceModeReader(moduleRef);
  }
}

@Module({ providers: [FeatureReader, WsMaintenanceGuard], exports: [FeatureReader] })
class FeatureModule {}

/** An app whose root module provides the switch, read from the feature module. */
async function appWithSwitch(mode: MaintenanceModeSwitch | undefined) {
  @Module({
    imports: [FeatureModule],
    providers: mode === undefined ? [] : provideCommonEnhancers({ maintenanceMode: mode }),
  })
  class RootModule {}
  const app = await Test.createTestingModule({ imports: [RootModule] }).compile();
  return {
    reader: app.get(FeatureReader),
    guard: app.get(WsMaintenanceGuard),
  };
}

const context = (type: string): ExecutionContext =>
  ({ getType: () => type }) as unknown as ExecutionContext;

describe('createMaintenanceModeReader', () => {
  it("reads the root module's switch from another module, where @Optional() injection sees none", async () => {
    const { reader } = await appWithSwitch(true);

    expect(reader.injected).toBeUndefined(); // the silent "off" this reader exists to avoid
    expect(reader.read()).toBe(true);
  });

  it('follows a function switch at every read', async () => {
    let on = false;
    const { reader } = await appWithSwitch(() => on);

    expect(reader.read()).toBe(false);
    on = true;
    expect(reader.read()).toBe(true);
    on = false;
    expect(reader.read()).toBe(false);
  });

  it('reads off when the app provides no switch (a service, a unit spec)', async () => {
    const { reader } = await appWithSwitch(undefined);

    expect(reader.read()).toBe(false);
  });

  it('looks the switch up once, at the first read, not at construction', () => {
    const get = vi.fn(() => true);
    const read = createMaintenanceModeReader({ get } as unknown as ModuleRef);

    expect(get).not.toHaveBeenCalled();
    expect(read()).toBe(true);
    expect(read()).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(MAINTENANCE_MODE, { strict: false });
  });

  it('a switch not built yet reads off and is looked up again at the next read', () => {
    const get = vi.fn<() => MaintenanceModeSwitch | undefined>(() => undefined);
    const read = createMaintenanceModeReader({ get } as unknown as ModuleRef);

    expect(read()).toBe(false);
    get.mockReturnValue(true);
    expect(read()).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('rethrows a lookup failure other than "not found" instead of reading off', () => {
    const fault = new Error('scope fault');
    const read = createMaintenanceModeReader({
      get: () => {
        throw fault;
      },
    } as unknown as ModuleRef);

    expect(() => read()).toThrow(fault);
  });
});

describe('WsMaintenanceGuard', () => {
  it('refuses a WebSocket message with the maintenance 503 while the switch is on', async () => {
    const { guard } = await appWithSwitch(true);

    let thrown: unknown;
    try {
      guard.canActivate(context('ws'));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    expect(toProblemDetails(thrown, { exposeInternal: false })).toEqual(maintenanceProblem());
  });

  it('lets anything that is not a WebSocket message through, even while the switch is on', async () => {
    const { guard } = await appWithSwitch(true);

    for (const type of ['http', 'rpc', 'graphql']) {
      expect(guard.canActivate(context(type))).toBe(true);
    }
  });

  it('follows a function switch: off passes, on refuses, off passes again', async () => {
    let on = false;
    const { guard } = await appWithSwitch(() => on);

    expect(guard.canActivate(context('ws'))).toBe(true);
    on = true;
    expect(() => guard.canActivate(context('ws'))).toThrow(ServiceUnavailableException);
    on = false;
    expect(guard.canActivate(context('ws'))).toBe(true);
  });

  it('passes when the app provides no switch', async () => {
    const { guard } = await appWithSwitch(undefined);

    expect(guard.canActivate(context('ws'))).toBe(true);
  });
});
